import chalk from 'chalk';
import * as fs from 'fs';
import { CellFlags, Ghostty, type GhosttyTerminal } from 'ghostty-web';
import { createRequire } from 'module';
import * as path from 'path';
import type { SessionInfo } from '../../shared/types.js';
import {
  CAST_REPLAY_MAX_BYTES,
  castReplayStart,
  findLastResizeBefore,
  forEachCastLine,
  readCastHeaderLine,
} from '../utils/cast-tail.js';
import { ErrorDeduplicator, formatErrorSummary } from '../utils/error-deduplicator.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('terminal-manager');

const SCROLLBACK_LIMIT = 10000;

const localRequire = createRequire(__filename);

export function resolveGhosttyWasmPath(moduleDir: string = __dirname): string {
  const candidates: string[] = [
    path.resolve(moduleDir, '../public/ghostty-vt.wasm'),
    path.resolve(moduleDir, '../../../public/ghostty-vt.wasm'),
    path.resolve(moduleDir, '../../public/ghostty-vt.wasm'),
  ];

  try {
    candidates.push(localRequire.resolve('ghostty-web/ghostty-vt.wasm'));
  } catch {
    // ignore
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(
    `ghostty-web wasm not found. Tried:\n${candidates.map((c) => `- ${c}`).join('\n')}`
  );
}

let ghosttyPromise: Promise<Ghostty> | null = null;
async function ensureGhostty(): Promise<Ghostty> {
  if (!ghosttyPromise) {
    ghosttyPromise = (async () => {
      const wasmPath = resolveGhosttyWasmPath();
      const wasmBytes = await fs.promises.readFile(wasmPath);

      type GhosttyWasmInstance = ConstructorParameters<typeof Ghostty>[0];
      type WebAssemblyInstantiateResult = { instance: GhosttyWasmInstance };
      type WebAssemblyLike = {
        instantiate: (
          bytes: Uint8Array,
          imports: Record<string, unknown>
        ) => Promise<WebAssemblyInstantiateResult>;
      };

      const wasm = (globalThis as unknown as { WebAssembly: WebAssemblyLike }).WebAssembly;
      const { instance } = await wasm.instantiate(wasmBytes, {
        env: {
          log: (_ptr: number, _len: number) => {
            // Intentionally no-op: ghostty can be noisy with stream warnings.
          },
        },
      });

      return new Ghostty(instance);
    })();
  }
  return ghosttyPromise;
}

// Helper function to truncate long strings for logging
function truncateForLog(str: string, maxLength: number = 50): string {
  if (str.length <= maxLength) return str;
  return `${str.substring(0, maxLength)}...(${str.length} chars total)`;
}

/**
 * Flow control used to pause a session's terminal once its scrollback passed 80% of
 * SCROLLBACK_LIMIT lines and resume it below 50%, but ghostty never shrinks its scrollback: the
 * server-side screen (/text, buffer snapshots) froze until a 5-minute timeout, which then dropped the lines queued meanwhile. ghostty's
 * limit is a byte budget, so the line count got there only on narrow terminals (about 15,000
 * lines at 5 columns, 1,100 at 80), but there it froze every time.
 *
 * The scrollback was never the risk, ghostty bounds it. What a flood can grow is output read
 * from the cast and not yet on the screen, and the CPU spent on it. So the cast on disk is the
 * queue: new output is read in 256 KB chunks and written to the terminal as it is read, in
 * order, at most LIVE_WRITE_CHUNK_CHARS at a time, and the next chunk is read only once this
 * one is on the screen. Nothing piles up in memory, nothing is paused, nothing is dropped. The
 * one deliberate cap: a terminal more than castReplayMaxBytes behind (a stalled event loop, a
 * flood faster than ghostty) skips to the end the way a new terminal's replay does, and logs it.
 */
const LIVE_WRITE_CHUNK_CHARS = 256 * 1024;

interface SessionTerminal {
  terminal: GhosttyTerminal;
  watcher?: fs.FSWatcher;
  lastUpdate: number;
  /** Settles once the cast's replay into the new terminal is done. */
  ready?: Promise<void>;
  /** Where the next read of the cast starts: always the start of a line. */
  lastFileOffset?: number;
  /** A read of new output is running; `readAgain` asks it for one more pass. */
  reading?: boolean;
  readAgain?: boolean;
}

type BufferChangeListener = (sessionId: string, snapshot: BufferSnapshot) => void;

interface BufferCell {
  char: string;
  width: number;
  fg?: number;
  bg?: number;
  attributes?: number;
}

interface BufferSnapshot {
  cols: number;
  rows: number;
  viewportY: number;
  cursorX: number;
  cursorY: number;
  cells: BufferCell[][];
}

/**
 * Manages terminal instances and their buffer operations for terminal sessions.
 *
 * Provides high-performance terminal emulation using ghostty-web (WASM) terminals,
 * with sophisticated flow control, buffer management, and real-time change
 * notifications. Handles asciinema stream parsing, terminal resizing, and
 * efficient binary encoding of terminal buffers.
 *
 * Key features:
 * - Headless Ghostty terminals with 10K line scrollback
 * - Asciinema v2 format stream parsing and playback
 * - Flow control: the cast on disk is the backlog, read as fast as the terminal takes it
 * - Efficient binary buffer encoding for WebSocket transmission
 * - Real-time buffer change notifications with debouncing
 * - Error deduplication to prevent log spam
 * - Automatic cleanup of stale terminals
 *
 * Flow control: see LIVE_WRITE_CHUNK_CHARS.
 *
 * @example
 * ```typescript
 * const manager = new TerminalManager('/var/run/vibetunnel');
 *
 * // Get terminal for session
 * const terminal = await manager.getTerminal(sessionId);
 *
 * // Subscribe to buffer changes
 * const unsubscribe = await manager.subscribeToBufferChanges(
 *   sessionId,
 *   (id, snapshot) => {
 *     const encoded = manager.encodeSnapshot(snapshot);
 *     ws.send(encoded);
 *   }
 * );
 * ```
 *
 * @see GhosttyTerminal - Terminal emulation engine
 * @see web/src/server/services/buffer-aggregator.ts - Aggregates buffer updates
 * @see web/src/server/pty/asciinema-writer.ts - Writes asciinema streams
 */
/** How long a terminal waits for a new session's cast file to appear (100 × 100 ms). */
const STREAM_FILE_WAIT_ATTEMPTS = 100;
const STREAM_FILE_WAIT_INTERVAL_MS = 100;

/** The plain-text fallback snapshot reads at most this much of the end of a cast. */
const FALLBACK_REPLAY_MAX_BYTES = 1024 * 1024;
/** Output written to a terminal at once while replaying a cast. */
const REPLAY_WRITE_CHUNK_CHARS = 1024 * 1024;

/** Output events read live, joined and written at most LIVE_WRITE_CHUNK_CHARS at a time. */
class LiveOutput {
  private parts: string[] = [];
  private chars = 0;

  constructor(private readonly write: (data: string) => void) {}

  push(data: string): void {
    this.parts.push(data);
    this.chars += data.length;
    if (this.chars >= LIVE_WRITE_CHUNK_CHARS) this.flush();
  }

  flush(): void {
    if (this.chars === 0 && this.parts.length === 0) return;
    const data = this.parts.join('');
    this.parts = [];
    this.chars = 0;
    if (data) this.write(data);
  }
}

export class TerminalManager {
  private terminals: Map<string, SessionTerminal> = new Map();
  private controlDir: string;
  private bufferListeners: Map<string, Set<BufferChangeListener>> = new Map();
  private changeTimers: Map<string, NodeJS.Timeout> = new Map();
  private errorDeduplicator = new ErrorDeduplicator({
    keyExtractor: (error, context) => {
      // Use session ID and line prefix as context for terminal parsing errors
      const errorMessage = error instanceof Error ? error.message : String(error);
      return `${context}:${errorMessage}`;
    },
  });
  /** Most bytes of a cast replayed into a terminal at once (CAST_REPLAY_MAX_BYTES). */
  private castReplayMaxBytes: number;

  constructor(controlDir: string, options: { castReplayMaxBytes?: number } = {}) {
    this.controlDir = controlDir;
    this.castReplayMaxBytes = options.castReplayMaxBytes ?? CAST_REPLAY_MAX_BYTES;
  }

  /**
   * Get or create a terminal for a session
   */
  async getTerminal(sessionId: string): Promise<GhosttyTerminal> {
    let sessionTerminal = this.terminals.get(sessionId);

    if (!sessionTerminal) {
      // Create new terminal
      const ghostty = await ensureGhostty();
      const terminal = ghostty.createTerminal(80, 24, { scrollbackLimit: SCROLLBACK_LIMIT });

      sessionTerminal = {
        terminal,
        lastUpdate: Date.now(),
      };

      this.terminals.set(sessionId, sessionTerminal);
      logger.log(
        chalk.green(`Terminal created for session ${sessionId} (${terminal.cols}x${terminal.rows})`)
      );

      // Start watching the stream file
      sessionTerminal.ready = this.watchStreamFile(sessionId);
      await sessionTerminal.ready;
    } else if (sessionTerminal.ready) {
      // The replay is asynchronous: a second reader waits for the screen it rebuilds.
      await sessionTerminal.ready.catch(() => {});
    }

    sessionTerminal.lastUpdate = Date.now();
    return sessionTerminal.terminal;
  }

  private async readSessionDimensions(
    sessionId: string
  ): Promise<{ cols?: number; rows?: number }> {
    const sessionJsonPath = path.join(this.controlDir, sessionId, 'session.json');
    if (!fs.existsSync(sessionJsonPath)) {
      return {};
    }

    try {
      const raw = await fs.promises.readFile(sessionJsonPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<SessionInfo>;
      const cols =
        typeof parsed.initialCols === 'number' && Number.isFinite(parsed.initialCols)
          ? parsed.initialCols
          : undefined;
      const rows =
        typeof parsed.initialRows === 'number' && Number.isFinite(parsed.initialRows)
          ? parsed.initialRows
          : undefined;
      return { cols, rows };
    } catch (error) {
      logger.debug(`Failed to read session.json for fallback ${truncateForLog(sessionId)}:`, error);
      return {};
    }
  }

  private async buildFallbackSnapshot(sessionId: string): Promise<BufferSnapshot> {
    const streamPath = path.join(this.controlDir, sessionId, 'stdout');
    const sessionDimensions = await this.readSessionDimensions(sessionId);
    const emptySnapshot = (): BufferSnapshot => ({
      cols: 1,
      rows: 1,
      viewportY: 0,
      cursorX: 0,
      cursorY: 0,
      cells: [[{ char: ' ', width: 1 }]],
    });

    if (!fs.existsSync(streamPath)) {
      return emptySnapshot();
    }

    // The header and the last MB only: a whole 1 GB cast does not fit in a string.
    const castLines: string[] = [];
    try {
      const size = (await fs.promises.stat(streamPath)).size;
      const header = await readCastHeaderLine(streamPath);
      if (header) castLines.push(header.line);
      const from = header?.end ?? 0;
      const { start } = await castReplayStart(streamPath, from, size, FALLBACK_REPLAY_MAX_BYTES);
      await forEachCastLine(streamPath, start, size, (line) => castLines.push(line));
    } catch (error) {
      logger.error(`Failed to read fallback stream for ${truncateForLog(sessionId)}:`, error);
      return emptySnapshot();
    }

    if (castLines.length === 0) {
      return emptySnapshot();
    }

    let output = '';
    let headerCols: number | undefined;
    let headerRows: number | undefined;
    let resizeCols: number | undefined;
    let resizeRows: number | undefined;
    for (const line of castLines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (Array.isArray(parsed) && parsed.length >= 3) {
          if (parsed[1] === 'o') {
            output += String(parsed[2]);
          } else if (parsed[1] === 'r') {
            const match = String(parsed[2]).match(/^(\d+)x(\d+)$/);
            if (match) {
              resizeCols = Number.parseInt(match[1], 10);
              resizeRows = Number.parseInt(match[2], 10);
            }
          }
        } else if (parsed && typeof parsed === 'object') {
          const width = (parsed as { width?: number }).width;
          const height = (parsed as { height?: number }).height;
          if (typeof width === 'number' && Number.isFinite(width)) headerCols = width;
          if (typeof height === 'number' && Number.isFinite(height)) headerRows = height;
        }
      } catch {
        // ignore malformed lines
      }
    }

    const fallbackCols = resizeCols ?? sessionDimensions.cols ?? headerCols;
    const fallbackRows = resizeRows ?? sessionDimensions.rows ?? headerRows;
    if (!output) {
      const cols = Math.max(1, fallbackCols ?? 1);
      const rows = Math.max(1, fallbackRows ?? 1);
      const cells: BufferCell[][] = Array.from({ length: rows }, () => [{ char: ' ', width: 1 }]);
      return {
        cols,
        rows,
        viewportY: 0,
        cursorX: 0,
        cursorY: 0,
        cells,
      };
    }

    const normalized = output.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // biome-ignore lint/complexity/useRegexLiterals: avoid control-character lint for ESC
    const ansiPattern = new RegExp('\\u001b\\[[0-9;?]*[a-zA-Z]', 'g');
    const stripped = normalized.replace(ansiPattern, '');
    const lines = stripped.split('\n');
    const rows = Math.max(1, fallbackRows ?? lines.length);
    const visibleLines = fallbackRows ? lines.slice(-rows) : lines;
    const outputCols = Math.max(1, ...visibleLines.map((line) => Array.from(line).length));
    const cols = Math.max(1, fallbackCols ?? outputCols);

    const cells: BufferCell[][] = visibleLines.map((line) => {
      const chars = Array.from(line);
      const truncated = cols ? chars.slice(0, cols) : chars;
      if (truncated.length === 0) {
        return [{ char: ' ', width: 1 }];
      }
      return truncated.map((char) => ({ char, width: 1 }));
    });

    while (cells.length < rows) {
      cells.push([{ char: ' ', width: 1 }]);
    }

    return {
      cols,
      rows,
      viewportY: 0,
      cursorX: 0,
      cursorY: 0,
      cells,
    };
  }

  /**
   * Watch stream file for changes
   */
  private async watchStreamFile(sessionId: string, attempt = 0): Promise<void> {
    const sessionTerminal = this.terminals.get(sessionId);
    if (!sessionTerminal) return;

    const streamPath = path.join(this.controlDir, sessionId, 'stdout');

    // Check if the file exists
    if (!fs.existsSync(streamPath)) {
      // A session asked for right after it was created may not have written its cast file
      // yet. Giving up here left that terminal empty for good (no screen text, no buffer
      // snapshots). Wait for it.
      if (attempt < STREAM_FILE_WAIT_ATTEMPTS) {
        const timer = setTimeout(() => {
          if (this.terminals.get(sessionId) === sessionTerminal) {
            void this.watchStreamFile(sessionId, attempt + 1);
          }
        }, STREAM_FILE_WAIT_INTERVAL_MS);
        timer.unref?.();
        return;
      }
      logger.error(
        `Stream file does not exist for session ${truncateForLog(sessionId)}: ${truncateForLog(streamPath, 100)}`
      );
      return;
    }

    try {
      // First time only: a watcher set up again goes on from where it stopped. It used to read
      // the whole file again from the start, replaying every line twice.
      if (sessionTerminal.lastFileOffset === undefined) {
        sessionTerminal.lastFileOffset = await this.replayCastTail(
          sessionId,
          sessionTerminal,
          streamPath
        );
      }
      if (this.terminals.get(sessionId) !== sessionTerminal || sessionTerminal.watcher) return;

      sessionTerminal.watcher = fs.watch(streamPath, (eventType) => {
        if (eventType === 'change') void this.readNewOutput(sessionId, sessionTerminal, streamPath);
      });
      // Whatever was written while the replay ran.
      void this.readNewOutput(sessionId, sessionTerminal, streamPath);

      logger.log(chalk.green(`Watching stream file for session ${truncateForLog(sessionId)}`));
    } catch (error) {
      logger.error(`Failed to watch stream file for session ${truncateForLog(sessionId)}:`, error);
      throw error;
    }
  }

  /**
   * Rebuild a new terminal's screen from the end of its cast: the header line, then at most
   * castReplayMaxBytes of events, from the last clear when it is in them, else from the first
   * whole line in them (with the terminal size in effect there). A full-screen app's last
   * repaints draw all of its screen; older history is not needed and a 1 GB cast does not
   * fit in a string. Written straight to the terminal, in order, so the screen is
   * right when this resolves. Returns the offset after the last complete line read.
   */
  private async replayCastTail(
    sessionId: string,
    sessionTerminal: SessionTerminal,
    streamPath: string
  ): Promise<number> {
    const terminal = sessionTerminal.terminal;
    const size = (await fs.promises.stat(streamPath)).size;
    const header = await readCastHeaderLine(streamPath);
    const from = header?.end ?? 0;
    const lastClearOffset =
      size - from > this.castReplayMaxBytes ? await this.readLastClearOffset(sessionId) : undefined;
    const { start, truncated } = await castReplayStart(
      streamPath,
      from,
      size,
      this.castReplayMaxBytes,
      lastClearOffset
    );

    // A terminal closed meanwhile has freed its WASM memory: nothing more may reach it.
    const closed = () => this.terminals.get(sessionId) !== sessionTerminal;
    let output: string[] = [];
    let outputChars = 0;
    const flush = () => {
      if (outputChars === 0) return;
      const data = output.join('');
      output = [];
      outputChars = 0;
      if (closed()) return;
      try {
        terminal.write(data);
      } catch (error) {
        logger.warn(`Terminal write error replaying ${truncateForLog(sessionId)}: ${error}`);
      }
    };
    const resize = (dimensions: string) => {
      const match = dimensions.match(/^(\d+)x(\d+)$/);
      if (!match) return;
      flush();
      if (closed()) return;
      terminal.resize(Number.parseInt(match[1], 10), Number.parseInt(match[2], 10));
    };
    let malformed = 0;
    const replayLine = (line: string) => {
      if (!line.trim()) return;
      let data: unknown;
      try {
        data = JSON.parse(line);
      } catch {
        malformed++;
        return;
      }
      if (Array.isArray(data)) {
        if (data.length < 3 || typeof data[2] !== 'string') return;
        if (data[1] === 'o') {
          output.push(data[2]);
          outputChars += data[2].length;
          if (outputChars >= REPLAY_WRITE_CHUNK_CHARS) flush();
        } else if (data[1] === 'r') {
          resize(data[2]);
        }
        return;
      }
      const { width, height } = (data ?? {}) as { width?: unknown; height?: unknown };
      if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
        flush();
        if (!closed()) terminal.resize(width, height);
      }
    };

    if (header) replayLine(header.line);
    if (truncated) {
      const dimensions = await findLastResizeBefore(streamPath, start, from);
      if (dimensions) resize(dimensions);
    }
    const end = await forEachCastLine(streamPath, start, size, replayLine);
    flush();

    if (malformed > 0) {
      logger.debug(`Skipped ${malformed} malformed cast lines of ${truncateForLog(sessionId)}`);
    }
    if (truncated) {
      logger.log(
        `Replayed the last ${Math.round((end - start) / 1024)} KB of the ${Math.round(size / 1024 / 1024)} MB cast of ${truncateForLog(sessionId)}`
      );
    }
    this.scheduleBufferChangeNotification(sessionId);
    return end;
  }

  /** The session's last clear offset from session.json, if it has one. */
  private async readLastClearOffset(sessionId: string): Promise<number | undefined> {
    try {
      const raw = await fs.promises.readFile(
        path.join(this.controlDir, sessionId, 'session.json'),
        'utf8'
      );
      const offset = (JSON.parse(raw) as Partial<SessionInfo>).lastClearOffset;
      return typeof offset === 'number' && Number.isFinite(offset) ? offset : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Hand the complete lines written since the last read to the terminal. Reads end on a line
   * boundary, so a half-written line is read again whole next time. One read at a time; a
   * change during it asks for another pass. Output reaches the terminal as it is read, so the
   * next chunk of the file is read only once this one is on the screen (LIVE_WRITE_CHUNK_CHARS).
   * A terminal more than castReplayMaxBytes behind skips to the end the way a new terminal's
   * replay does, and logs it.
   */
  private async readNewOutput(
    sessionId: string,
    sessionTerminal: SessionTerminal,
    streamPath: string
  ): Promise<void> {
    if (sessionTerminal.reading) {
      sessionTerminal.readAgain = true;
      return;
    }
    sessionTerminal.reading = true;
    try {
      do {
        sessionTerminal.readAgain = false;
        if (this.terminals.get(sessionId) !== sessionTerminal || !sessionTerminal.watcher) return;
        const size = (await fs.promises.stat(streamPath)).size;
        let from = sessionTerminal.lastFileOffset ?? 0;
        if (size <= from) continue;
        if (size - from > this.castReplayMaxBytes) {
          from = (await castReplayStart(streamPath, from, size, this.castReplayMaxBytes)).start;
          logger.warn(
            `Skipped ${Math.round((from - (sessionTerminal.lastFileOffset ?? 0)) / 1024)} KB of output of ${truncateForLog(sessionId)}: its terminal fell more than ${Math.round(this.castReplayMaxBytes / 1024)} KB behind`
          );
        }
        const output = new LiveOutput((data) => this.writeOutput(sessionId, sessionTerminal, data));
        try {
          sessionTerminal.lastFileOffset = await forEachCastLine(streamPath, from, size, (line) => {
            if (line.trim()) this.processStreamLine(sessionId, sessionTerminal, line, output);
          });
        } finally {
          output.flush();
        }
      } while (sessionTerminal.readAgain);
    } catch (error) {
      logger.error(`Error reading stream file for session ${truncateForLog(sessionId)}:`, error);
    } finally {
      sessionTerminal.reading = false;
    }
  }

  /**
   * Hand one cast line read live to the terminal: output is batched in `output`, which is
   * flushed before anything else reaches the terminal so everything stays in order.
   */
  private processStreamLine(
    sessionId: string,
    sessionTerminal: SessionTerminal,
    line: string,
    output: LiveOutput
  ) {
    try {
      const data = JSON.parse(line);
      // Output first: the line may change the terminal, or close it.
      const isOutput = Array.isArray(data) && data.length >= 3 && data[1] === 'o';
      if (!isOutput) output.flush();
      if (this.terminals.get(sessionId) !== sessionTerminal) return;

      // Handle asciinema header
      if (data.version && data.width && data.height) {
        sessionTerminal.terminal.resize(data.width, data.height);
        this.notifyBufferChange(sessionId);
        return;
      }

      // Handle asciinema events [timestamp, type, data]
      if (Array.isArray(data) && data.length >= 3) {
        const [timestamp, type, eventData] = data;

        if (timestamp === 'exit') {
          // Session exited
          logger.log(
            chalk.yellow(`Session ${truncateForLog(sessionId)} exited with code ${data[1]}`)
          );
          if (sessionTerminal.watcher) {
            sessionTerminal.watcher.close();
          }
          return;
        }

        if (type === 'o') {
          if (typeof eventData === 'string') output.push(eventData);
        } else if (type === 'r') {
          // Resize event
          const match = eventData.match(/^(\d+)x(\d+)$/);
          if (match) {
            const cols = Number.parseInt(match[1], 10);
            const rows = Number.parseInt(match[2], 10);
            sessionTerminal.terminal.resize(cols, rows);
            this.notifyBufferChange(sessionId);
          }
        }
        // Ignore 'i' (input) events
      }
    } catch (error) {
      // Use deduplicator to check if we should log this error
      // Use a more generic context key to group similar parsing errors together
      const contextKey = `${sessionId}:parse-stream-line`;

      if (this.errorDeduplicator.shouldLog(error, contextKey)) {
        const stats = this.errorDeduplicator.getErrorStats(error, contextKey);

        if (stats && stats.count > 1) {
          // Log summary for repeated errors
          logger.warn(formatErrorSummary(error, stats, `session ${truncateForLog(sessionId)}`));
        } else {
          // First occurrence - log the error with details
          const truncatedLine = line.length > 100 ? `${line.substring(0, 100)}...` : line;
          logger.error(
            `Failed to parse stream line for session ${truncateForLog(sessionId)}: ${truncatedLine}`
          );
          if (error instanceof Error && error.stack) {
            logger.debug(`Parse error details: ${error.message}`);
          }
        }
      }
    }
  }

  /**
   * Get buffer stats for a session
   */
  async getBufferStats(sessionId: string) {
    const terminal = await this.getTerminal(sessionId);
    terminal.update();
    const cursor = terminal.getCursor();
    const scrollbackLength = terminal.getScrollbackLength();
    const totalRows = scrollbackLength + terminal.rows;
    logger.debug(
      `Getting buffer stats for session ${truncateForLog(sessionId)}: ${totalRows} total rows`
    );

    const maxLines = SCROLLBACK_LIMIT;
    const bufferUtilization = totalRows / maxLines;

    return {
      totalRows,
      cols: terminal.cols,
      rows: terminal.rows,
      viewportY: cursor.viewportY,
      cursorX: cursor.x,
      cursorY: cursor.y,
      scrollback: scrollbackLength,
      bufferUtilization: Math.round(bufferUtilization * 100),
      maxBufferLines: maxLines,
    };
  }

  /**
   * Get buffer snapshot for a session - always returns full terminal buffer (cols x rows)
   */
  async getBufferSnapshot(sessionId: string): Promise<BufferSnapshot> {
    const startTime = Date.now();
    let terminal: GhosttyTerminal;
    try {
      terminal = await this.getTerminal(sessionId);
    } catch (error) {
      logger.error(`Failed to init terminal for snapshot ${truncateForLog(sessionId)}:`, error);
      return this.buildFallbackSnapshot(sessionId);
    }

    try {
      terminal.update();
    } catch (error) {
      logger.error(`Failed to update terminal for snapshot ${truncateForLog(sessionId)}:`, error);
      return this.buildFallbackSnapshot(sessionId);
    }
    const cols = terminal.cols;
    const rows = terminal.rows;
    const viewport = terminal.getViewport();
    const cursor = terminal.getCursor();
    const colors = terminal.getColors() as
      | {
          foreground: { r: number; g: number; b: number };
          background: { r: number; g: number; b: number };
        }
      | undefined;
    if (!colors?.foreground || !colors?.background) {
      return this.buildFallbackSnapshot(sessionId);
    }

    const defaultFg =
      (colors.foreground.r << 16) | (colors.foreground.g << 8) | colors.foreground.b;
    const defaultBg =
      (colors.background.r << 16) | (colors.background.g << 8) | colors.background.b;

    const cells: BufferCell[][] = [];

    for (let row = 0; row < rows; row++) {
      const rowCells: BufferCell[] = [];

      for (let col = 0; col < cols; col++) {
        const cell = viewport[row * cols + col];
        if (!cell) continue;

        const width = cell.width;
        if (width === 0) continue;

        let char = ' ';
        if (cell.codepoint !== 0) {
          if (cell.grapheme_len && cell.grapheme_len > 1) {
            char = terminal.getGraphemeString(row, col) || ' ';
          } else {
            char = String.fromCodePoint(cell.codepoint);
          }
        }

        let attributes = 0;
        if (cell.flags & CellFlags.BOLD) attributes |= 0x01;
        if (cell.flags & CellFlags.ITALIC) attributes |= 0x02;
        if (cell.flags & CellFlags.UNDERLINE) attributes |= 0x04;
        if (cell.flags & CellFlags.FAINT) attributes |= 0x08;
        if (cell.flags & CellFlags.INVERSE) attributes |= 0x10;
        if (cell.flags & CellFlags.INVISIBLE) attributes |= 0x20;
        if (cell.flags & CellFlags.STRIKETHROUGH) attributes |= 0x40;

        const bufferCell: BufferCell = { char, width };

        const fg = (cell.fg_r << 16) | (cell.fg_g << 8) | cell.fg_b;
        const bg = (cell.bg_r << 16) | (cell.bg_g << 8) | cell.bg_b;

        if (fg !== defaultFg) bufferCell.fg = fg;
        if (bg !== defaultBg) bufferCell.bg = bg;
        if (attributes !== 0) bufferCell.attributes = attributes;

        rowCells.push(bufferCell);
      }

      // Trim trailing blanks but keep at least one cell for height
      let lastNonBlankCell = rowCells.length - 1;
      while (lastNonBlankCell >= 0) {
        const cell = rowCells[lastNonBlankCell];
        if (
          cell.char !== ' ' ||
          cell.fg !== undefined ||
          cell.bg !== undefined ||
          cell.attributes !== undefined
        ) {
          break;
        }
        lastNonBlankCell--;
      }

      if (lastNonBlankCell < rowCells.length - 1) {
        rowCells.splice(Math.max(1, lastNonBlankCell + 1));
      }

      if (rowCells.length === 0) rowCells.push({ char: ' ', width: 1 });
      cells.push(rowCells);
    }

    // Trim blank lines from the bottom
    let lastNonBlankRow = cells.length - 1;
    while (lastNonBlankRow >= 0) {
      const row = cells[lastNonBlankRow];
      const hasContent = row.some(
        (cell) =>
          cell.char !== ' ' ||
          cell.fg !== undefined ||
          cell.bg !== undefined ||
          cell.attributes !== undefined
      );
      if (hasContent) break;
      lastNonBlankRow--;
    }

    // Keep at least one row
    const trimmedCells = cells.slice(0, Math.max(1, lastNonBlankRow + 1));

    const duration = Date.now() - startTime;
    if (duration > 10) {
      logger.debug(
        `Buffer snapshot for session ${sessionId} took ${duration}ms (${trimmedCells.length} rows)`
      );
    }

    return {
      cols,
      rows: trimmedCells.length,
      viewportY: cursor.viewportY,
      cursorX: cursor.x,
      cursorY: cursor.y,
      cells: trimmedCells,
    };
  }

  /**
   * Encode buffer snapshot to binary format
   *
   * Converts a buffer snapshot into an optimized binary format for
   * efficient transmission over WebSocket. The encoding uses various
   * compression techniques:
   *
   * - Empty rows are marked with 2-byte markers
   * - Spaces with default styling use 1 byte
   * - ASCII characters with colors use 2-8 bytes
   * - Unicode characters use variable length encoding
   *
   * The binary format is designed for fast decoding on the client
   * while minimizing bandwidth usage.
   *
   * @param snapshot - Terminal buffer snapshot to encode
   * @returns Binary buffer ready for transmission
   *
   * @example
   * ```typescript
   * const snapshot = await manager.getBufferSnapshot('session-123');
   * const binary = manager.encodeSnapshot(snapshot);
   *
   * // Send over WebSocket with session ID
   * const packet = Buffer.concat([
   *   Buffer.from([0xBF]), // Magic byte
   *   Buffer.from(sessionId.length.toString(16), 'hex'),
   *   Buffer.from(sessionId),
   *   binary
   * ]);
   * ws.send(packet);
   * ```
   */
  encodeSnapshot(snapshot: BufferSnapshot): Buffer {
    const startTime = Date.now();
    const { cols, rows, viewportY, cursorX, cursorY, cells } = snapshot;

    // Pre-calculate actual data size for efficiency
    let dataSize = 32; // Header size

    // First pass: calculate exact size needed
    for (let row = 0; row < cells.length; row++) {
      const rowCells = cells[row];
      if (
        rowCells.length === 0 ||
        (rowCells.length === 1 &&
          rowCells[0].char === ' ' &&
          !rowCells[0].fg &&
          !rowCells[0].bg &&
          !rowCells[0].attributes)
      ) {
        // Empty row marker: 2 bytes
        dataSize += 2;
      } else {
        // Row header: 3 bytes (marker + length)
        dataSize += 3;

        for (const cell of rowCells) {
          dataSize += this.calculateCellSize(cell);
        }
      }
    }

    const buffer = Buffer.allocUnsafe(dataSize);
    let offset = 0;

    // Write header (32 bytes)
    buffer.writeUInt16LE(0x5654, offset);
    offset += 2; // Magic "VT"
    buffer.writeUInt8(0x01, offset); // Version 1 - our only format
    offset += 1; // Version
    buffer.writeUInt8(0x00, offset);
    offset += 1; // Flags
    buffer.writeUInt32LE(cols, offset);
    offset += 4; // Cols (32-bit)
    buffer.writeUInt32LE(rows, offset);
    offset += 4; // Rows (32-bit)
    buffer.writeInt32LE(viewportY, offset); // Signed for large buffers
    offset += 4; // ViewportY (32-bit signed)
    buffer.writeInt32LE(cursorX, offset); // Signed for consistency
    offset += 4; // CursorX (32-bit signed)
    buffer.writeInt32LE(cursorY, offset); // Signed for relative positions
    offset += 4; // CursorY (32-bit signed)
    buffer.writeUInt32LE(0, offset);
    offset += 4; // Reserved

    // Write cells with new optimized format
    for (let row = 0; row < cells.length; row++) {
      const rowCells = cells[row];

      // Check if this is an empty row
      if (
        rowCells.length === 0 ||
        (rowCells.length === 1 &&
          rowCells[0].char === ' ' &&
          !rowCells[0].fg &&
          !rowCells[0].bg &&
          !rowCells[0].attributes)
      ) {
        // Empty row marker
        buffer.writeUInt8(0xfe, offset++); // Empty row marker
        buffer.writeUInt8(1, offset++); // Count of empty rows (for now just 1)
      } else {
        // Row with content
        buffer.writeUInt8(0xfd, offset++); // Row marker
        buffer.writeUInt16LE(rowCells.length, offset); // Number of cells in row
        offset += 2;

        // Write each cell
        for (const cell of rowCells) {
          offset = this.encodeCell(buffer, offset, cell);
        }
      }
    }

    // Return exact size buffer
    const result = buffer.subarray(0, offset);

    const duration = Date.now() - startTime;
    if (duration > 5) {
      logger.debug(`Encoded snapshot: ${result.length} bytes in ${duration}ms (${rows} rows)`);
    }

    return result;
  }

  /**
   * Calculate the size needed to encode a cell
   */
  private calculateCellSize(cell: BufferCell): number {
    // Optimized encoding:
    // - Simple space with default colors: 1 byte
    // - ASCII char with default colors: 2 bytes
    // - ASCII char with colors/attrs: 2-8 bytes
    // - Unicode char: variable

    const isSpace = cell.char === ' ';
    const hasAttrs = cell.attributes && cell.attributes !== 0;
    const hasFg = cell.fg !== undefined;
    const hasBg = cell.bg !== undefined;
    const isAscii = cell.char.charCodeAt(0) <= 127;

    if (isSpace && !hasAttrs && !hasFg && !hasBg) {
      return 1; // Just a space marker
    }

    let size = 1; // Type byte

    if (isAscii) {
      size += 1; // ASCII character
    } else {
      const charBytes = Buffer.byteLength(cell.char, 'utf8');
      size += 1 + charBytes; // Length byte + UTF-8 bytes
    }

    // Attributes/colors byte
    if (hasAttrs || hasFg || hasBg) {
      size += 1; // Flags byte

      if (hasFg && cell.fg !== undefined) {
        size += cell.fg > 255 ? 3 : 1; // RGB or palette
      }

      if (hasBg && cell.bg !== undefined) {
        size += cell.bg > 255 ? 3 : 1; // RGB or palette
      }
    }

    return size;
  }

  /**
   * Encode a single cell into the buffer
   */
  private encodeCell(buffer: Buffer, offset: number, cell: BufferCell): number {
    const isSpace = cell.char === ' ';
    const hasAttrs = cell.attributes && cell.attributes !== 0;
    const hasFg = cell.fg !== undefined;
    const hasBg = cell.bg !== undefined;
    const isAscii = cell.char.charCodeAt(0) <= 127;

    // Type byte format:
    // Bit 7: Has extended data (attrs/colors)
    // Bit 6: Is Unicode (vs ASCII)
    // Bit 5: Has foreground color
    // Bit 4: Has background color
    // Bit 3: Is RGB foreground (vs palette)
    // Bit 2: Is RGB background (vs palette)
    // Bits 1-0: Character type (00=space, 01=ASCII, 10=Unicode)

    if (isSpace && !hasAttrs && !hasFg && !hasBg) {
      // Simple space - 1 byte
      buffer.writeUInt8(0x00, offset++); // Type: space, no extended data
      return offset;
    }

    let typeByte = 0;

    if (hasAttrs || hasFg || hasBg) {
      typeByte |= 0x80; // Has extended data
    }

    if (!isAscii) {
      typeByte |= 0x40; // Is Unicode
      typeByte |= 0x02; // Character type: Unicode
    } else if (!isSpace) {
      typeByte |= 0x01; // Character type: ASCII
    }

    if (hasFg && cell.fg !== undefined) {
      typeByte |= 0x20; // Has foreground
      if (cell.fg > 255) typeByte |= 0x08; // Is RGB
    }

    if (hasBg && cell.bg !== undefined) {
      typeByte |= 0x10; // Has background
      if (cell.bg > 255) typeByte |= 0x04; // Is RGB
    }

    buffer.writeUInt8(typeByte, offset++);

    // Write character
    if (!isAscii) {
      const charBytes = Buffer.from(cell.char, 'utf8');
      buffer.writeUInt8(charBytes.length, offset++);
      charBytes.copy(buffer, offset);
      offset += charBytes.length;
    } else if (!isSpace) {
      buffer.writeUInt8(cell.char.charCodeAt(0), offset++);
    }

    // Write extended data if present
    if (typeByte & 0x80) {
      // Attributes byte (if any)
      if (hasAttrs && cell.attributes !== undefined) {
        buffer.writeUInt8(cell.attributes, offset++);
      } else if (hasFg || hasBg) {
        buffer.writeUInt8(0, offset++); // No attributes but need the byte
      }

      // Foreground color
      if (hasFg && cell.fg !== undefined) {
        if (cell.fg > 255) {
          // RGB
          buffer.writeUInt8((cell.fg >> 16) & 0xff, offset++);
          buffer.writeUInt8((cell.fg >> 8) & 0xff, offset++);
          buffer.writeUInt8(cell.fg & 0xff, offset++);
        } else {
          // Palette
          buffer.writeUInt8(cell.fg, offset++);
        }
      }

      // Background color
      if (hasBg && cell.bg !== undefined) {
        if (cell.bg > 255) {
          // RGB
          buffer.writeUInt8((cell.bg >> 16) & 0xff, offset++);
          buffer.writeUInt8((cell.bg >> 8) & 0xff, offset++);
          buffer.writeUInt8(cell.bg & 0xff, offset++);
        } else {
          // Palette
          buffer.writeUInt8(cell.bg, offset++);
        }
      }
    }

    return offset;
  }

  /**
   * Close a terminal session
   */
  closeTerminal(sessionId: string): void {
    const sessionTerminal = this.terminals.get(sessionId);
    if (sessionTerminal) {
      if (sessionTerminal.watcher) {
        sessionTerminal.watcher.close();
      }
      sessionTerminal.terminal.free();
      this.terminals.delete(sessionId);

      logger.log(chalk.yellow(`Terminal closed for session ${truncateForLog(sessionId)}`));
    }
  }

  /**
   * Clean up old terminals
   */
  cleanup(maxAge: number = 30 * 60 * 1000): void {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [sessionId, sessionTerminal] of this.terminals) {
      if (now - sessionTerminal.lastUpdate > maxAge) {
        toRemove.push(sessionId);
      }
    }

    for (const sessionId of toRemove) {
      logger.log(
        chalk.yellow(`Cleaning up stale terminal for session ${truncateForLog(sessionId)}`)
      );
      this.closeTerminal(sessionId);
    }

    if (toRemove.length > 0) {
      logger.log(chalk.gray(`Cleaned up ${toRemove.length} stale terminals`));
    }
  }

  /** Write live output to the terminal, then let listeners know (debounced). */
  private writeOutput(sessionId: string, sessionTerminal: SessionTerminal, data: string) {
    if (this.terminals.get(sessionId) !== sessionTerminal) return;
    try {
      sessionTerminal.terminal.write(data);
    } catch (error) {
      // Use error deduplicator to prevent log spam
      const contextKey = `${sessionId}:terminal-write`;

      if (this.errorDeduplicator.shouldLog(error, contextKey)) {
        const stats = this.errorDeduplicator.getErrorStats(error, contextKey);

        if (stats && stats.count > 1) {
          // Log summary for repeated errors
          logger.warn(
            formatErrorSummary(
              error,
              stats,
              `terminal write for session ${truncateForLog(sessionId)}`
            )
          );
        } else {
          // First occurrence - log with more detail
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.warn(
            `Terminal write error for session ${truncateForLog(sessionId)}: ${errorMessage}`
          );
          if (error instanceof Error && error.stack) {
            logger.debug(`Write error stack: ${error.stack}`);
          }
        }
      }
    }

    this.scheduleBufferChangeNotification(sessionId);
  }

  /**
   * Get all active terminals
   */
  getActiveTerminals(): string[] {
    return Array.from(this.terminals.keys());
  }

  /**
   * Subscribe to buffer changes for a session
   */
  async subscribeToBufferChanges(
    sessionId: string,
    listener: BufferChangeListener
  ): Promise<() => void> {
    // Ensure terminal exists and is watching
    try {
      await this.getTerminal(sessionId);
    } catch (error) {
      logger.error(`Failed to init terminal for subscription ${truncateForLog(sessionId)}:`, error);
    }

    if (!this.bufferListeners.has(sessionId)) {
      this.bufferListeners.set(sessionId, new Set());
    }

    const listeners = this.bufferListeners.get(sessionId);
    if (listeners) {
      listeners.add(listener);
      logger.log(
        chalk.blue(`Buffer listener subscribed for session ${sessionId} (${listeners.size} total)`)
      );
    }

    // Send an immediate snapshot so new subscribers see a preview without waiting for output
    try {
      const snapshot = await this.getBufferSnapshot(sessionId);
      listener(sessionId, snapshot);
    } catch (error) {
      logger.error(
        `Error getting initial buffer snapshot for ${truncateForLog(sessionId)}:`,
        error
      );
    }

    // Return unsubscribe function
    return () => {
      const listeners = this.bufferListeners.get(sessionId);
      if (listeners) {
        listeners.delete(listener);
        logger.log(
          chalk.yellow(
            `Buffer listener unsubscribed for session ${sessionId} (${listeners.size} remaining)`
          )
        );
        if (listeners.size === 0) {
          this.bufferListeners.delete(sessionId);
        }
      }
    };
  }

  /**
   * Schedule buffer change notification (debounced)
   */
  private scheduleBufferChangeNotification(sessionId: string) {
    // Cancel existing timer
    const existingTimer = this.changeTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Schedule new notification in 50ms
    const timer = setTimeout(() => {
      this.changeTimers.delete(sessionId);
      this.notifyBufferChange(sessionId);
    }, 50);

    this.changeTimers.set(sessionId, timer);
  }

  /**
   * Notify listeners of buffer change
   */
  private async notifyBufferChange(sessionId: string) {
    const listeners = this.bufferListeners.get(sessionId);
    if (!listeners || listeners.size === 0) return;

    // logger.debug(
    //   `Notifying ${listeners.size} buffer change listeners for session ${truncateForLog(sessionId)}`
    // );

    try {
      // Get full buffer snapshot
      const snapshot = await this.getBufferSnapshot(sessionId);

      // Notify all listeners
      listeners.forEach((listener) => {
        try {
          listener(sessionId, snapshot);
        } catch (error) {
          logger.error(
            `Error notifying buffer change listener for ${truncateForLog(sessionId)}:`,
            error
          );
        }
      });
    } catch (error) {
      logger.error(
        `Error getting buffer snapshot for notification ${truncateForLog(sessionId)}:`,
        error
      );
    }
  }

  /**
   * Destroy the terminal manager and restore console overrides
   */
  destroy(): void {
    // Close all terminals
    for (const sessionId of this.terminals.keys()) {
      this.closeTerminal(sessionId);
    }

    // Clear all timers
    for (const timer of this.changeTimers.values()) {
      clearTimeout(timer);
    }
    this.changeTimers.clear();
  }
}
