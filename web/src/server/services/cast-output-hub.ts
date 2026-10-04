import chalk from 'chalk';
import * as fs from 'fs';
import type { SessionManager } from '../pty/session-manager.js';
import type { AsciinemaHeader } from '../pty/types.js';
import {
  CAST_REPLAY_MAX_BYTES,
  castReplayStart,
  findLastResizeBefore,
  findLineStart,
  forEachCastLine,
} from '../utils/cast-tail.js';
import { createLogger } from '../utils/logger.js';
import {
  calculatePruningPositionInFile,
  containsPruningSequence,
  findLastPrunePoint,
  logPruningDetection,
} from '../utils/pruning-detector.js';

const logger = createLogger('cast-output-hub');

const HEADER_READ_BUFFER_SIZE = 4096;

/**
 * How often a followed cast is checked for output its fs.watch did not report. On macOS a write
 * landing just after the watcher starts goes unreported (output appended right after
 * a phone subscribed stayed off it until the next write, for good on an idle session). A check
 * with nothing new is one stat.
 */
const WATCH_POLL_MS = 1000;

type AsciinemaOutputEvent = [number, 'o', string];
type AsciinemaInputEvent = [number, 'i', string];
type AsciinemaResizeEvent = [number, 'r', string];
type AsciinemaExitEvent = ['exit', number, string];
type AsciinemaEvent =
  | AsciinemaOutputEvent
  | AsciinemaInputEvent
  | AsciinemaResizeEvent
  | AsciinemaExitEvent;

function isOutputEvent(event: AsciinemaEvent): event is AsciinemaOutputEvent {
  return (
    Array.isArray(event) && event.length === 3 && event[1] === 'o' && typeof event[0] === 'number'
  );
}

function isResizeEvent(event: AsciinemaEvent): event is AsciinemaResizeEvent {
  return (
    Array.isArray(event) && event.length === 3 && event[1] === 'r' && typeof event[0] === 'number'
  );
}

function isExitEvent(event: AsciinemaEvent): event is AsciinemaExitEvent {
  return Array.isArray(event) && event[0] === 'exit';
}

export type CastOutputHubEvent =
  | { kind: 'header'; header: AsciinemaHeader }
  | { kind: 'output'; data: string; historical: boolean }
  | { kind: 'resize'; dimensions: string; historical: boolean }
  | { kind: 'exit'; exitCode: number }
  | { kind: 'error'; message: string };

export type CastOutputHubListener = (event: CastOutputHubEvent) => void;

/** Sent before the history a reset replays: a full terminal reset (RIS). */
const RESET_EVENT: CastOutputHubEvent = { kind: 'output', data: '\x1bc', historical: true };

interface HubClient {
  /** Takes a live event; held back while this client's replay runs. */
  deliver: CastOutputHubListener;
  /** (Re)plays the history up to lastOffset, first resetting the terminal when asked. */
  replay: (reset: boolean) => void;
}

interface WatcherInfo {
  streamPath: string;
  clients: Set<HubClient>;
  watcher?: fs.FSWatcher;
  /** Reads new output now and then in case the watcher missed a change (WATCH_POLL_MS). */
  poll?: NodeJS.Timeout;
  /**
   * End of the last complete line handed to the clients: live follow reads on from here, a
   * new subscriber's replay ends here. A trailing partial line is read again once it ends, so
   * a UTF-8 character split across two writes stays whole.
   */
  lastOffset: number;
  /** A read is running; `readAgain` asks it for one more pass when it is done. */
  reading: boolean;
  readAgain: boolean;
  retryTimer?: NodeJS.Timeout;
}

export class CastOutputHub {
  private activeWatchers: Map<string, WatcherInfo> = new Map();
  /** Most bytes of history replayed to a subscriber (CAST_REPLAY_MAX_BYTES). */
  private replayMaxBytes: number;

  constructor(
    private sessionManager: SessionManager,
    options: { replayMaxBytes?: number } = {}
  ) {
    this.replayMaxBytes = options.replayMaxBytes ?? CAST_REPLAY_MAX_BYTES;
    process.on('beforeExit', () => this.cleanup());
  }

  subscribe(sessionId: string, listener: CastOutputHubListener): () => void {
    const paths = this.sessionManager.getSessionPaths(sessionId, true);
    if (!paths) {
      listener({ kind: 'error', message: 'Session paths not found' });
      return () => {};
    }

    const streamPath = paths.stdoutPath;
    let watcherInfo = this.activeWatchers.get(sessionId);

    if (!watcherInfo) {
      watcherInfo = {
        streamPath,
        clients: new Set(),
        lastOffset: 0,
        reading: false,
        readAgain: false,
      };
      this.activeWatchers.set(sessionId, watcherInfo);

      // Live follow starts after the last complete line; a half-written one is read live.
      if (fs.existsSync(streamPath)) {
        watcherInfo.lastOffset = findLineStart(streamPath, fs.statSync(streamPath).size);
      }

      // Start watching (or retry until file exists).
      this.startWatchingWithRetry(sessionId, watcherInfo);
    }

    // The replay used to read the file to EOF asynchronously while live events were
    // already delivered to the same listener, so a session writing while a phone
    // (re)subscribed showed new output before the history and lines from both paths
    // twice. Replay stops where live follow starts and live events wait for it.
    let pending: CastOutputHubEvent[] | null = null;
    let active = true;
    let replays = 0;
    const info = watcherInfo;
    const client: HubClient = {
      deliver: (event) => {
        if (pending) pending.push(event);
        else if (active) listener(event);
      },
      replay: (reset) => {
        // A newer replay (after a reset) supersedes one still running.
        const replay = ++replays;
        const replayListener: CastOutputHubListener = (event) => {
          if (active && replay === replays) listener(event);
        };
        pending = [];
        if (reset) replayListener(RESET_EVENT);
        const done = () => {
          if (replay !== replays) return;
          const queued = pending ?? [];
          pending = null;
          for (const event of queued) replayListener(event);
        };
        // After a reset the saved clear offset points into the old content: scan for one.
        this.sendExistingContent(
          sessionId,
          info.streamPath,
          info.lastOffset,
          !reset,
          replayListener,
          done
        );
      },
    };
    watcherInfo.clients.add(client);
    client.replay(false);

    return () => {
      active = false;
      pending = null;
      const current = this.activeWatchers.get(sessionId);
      if (!current) return;
      current.clients.delete(client);

      if (current.clients.size === 0) {
        this.stopWatching(sessionId);
      }
    };
  }

  private stopWatching(sessionId: string) {
    const watcherInfo = this.activeWatchers.get(sessionId);
    if (!watcherInfo) return;

    watcherInfo.retryTimer && clearTimeout(watcherInfo.retryTimer);
    watcherInfo.watcher?.close();
    watcherInfo.watcher = undefined;
    clearInterval(watcherInfo.poll);
    this.activeWatchers.delete(sessionId);
    logger.debug(chalk.yellow(`stopped cast watcher for session ${sessionId}`));
  }

  private startWatchingWithRetry(sessionId: string, watcherInfo: WatcherInfo) {
    if (watcherInfo.watcher) return;

    if (!fs.existsSync(watcherInfo.streamPath)) {
      watcherInfo.retryTimer = setTimeout(() => {
        watcherInfo.retryTimer = undefined;
        this.startWatchingWithRetry(sessionId, watcherInfo);
      }, 200);
      return;
    }

    this.startWatching(sessionId, watcherInfo);
  }

  private startWatching(sessionId: string, watcherInfo: WatcherInfo): void {
    watcherInfo.watcher = fs.watch(watcherInfo.streamPath, { persistent: true }, (eventType) => {
      if (eventType === 'change') void this.readNewOutput(sessionId, watcherInfo);
    });
    this.startPoll(sessionId, watcherInfo);

    watcherInfo.watcher.on('error', (error) => {
      logger.error(`file watcher error for session ${sessionId}:`, error);
    });

    logger.debug(chalk.green(`watching cast file for session ${sessionId}`));
  }

  private startPoll(sessionId: string, watcherInfo: WatcherInfo): void {
    if (watcherInfo.poll) return;
    watcherInfo.poll = setInterval(
      () => void this.readNewOutput(sessionId, watcherInfo),
      WATCH_POLL_MS
    );
    watcherInfo.poll.unref?.();
  }

  /**
   * Hand the complete lines written since lastOffset to the clients, in order and once each.
   * This used to read all new bytes in one buffer and decoded them in one go, so a burst
   * of hundreds of MB was held whole in memory, and one past V8's string limit threw and lost
   * every line in it. Lines now stream in 256 KB chunks (forEachCastLine), the next chunk read
   * only after this one's lines went out, so sockets drain in between (a client that falls
   * MAX_CLIENT_BUFFERED_BYTES behind is dropped by the WebSocket hub). A follower more than
   * replayMaxBytes behind skips to the end like a new subscriber's replay, and says so.
   */
  private async readNewOutput(sessionId: string, watcherInfo: WatcherInfo): Promise<void> {
    if (watcherInfo.reading) {
      watcherInfo.readAgain = true;
      return;
    }
    watcherInfo.reading = true;
    try {
      do {
        watcherInfo.readAgain = false;
        if (this.activeWatchers.get(sessionId) !== watcherInfo) return;
        const streamPath = watcherInfo.streamPath;
        const size = (await fs.promises.stat(streamPath)).size;
        if (size < watcherInfo.lastOffset) {
          // A cast that shrank (a forwarder restarted under the same id truncates it) never
          // passed the old offset again, so its clients froze. Start over: reset their
          // terminals and replay the new file's bounded tail, then follow it.
          logger.warn(
            `cast of ${sessionId} shrank to ${size} bytes (was followed up to ${watcherInfo.lastOffset}); resetting its live stream`
          );
          watcherInfo.lastOffset = findLineStart(streamPath, size);
          for (const client of watcherInfo.clients) client.replay(true);
          this.startPoll(sessionId, watcherInfo); // stopped if the old content ended in an exit
          watcherInfo.readAgain = true;
          continue;
        }
        const behind = size - watcherInfo.lastOffset;
        if (behind <= 0) continue;
        if (behind > this.replayMaxBytes) {
          const { start } = await castReplayStart(
            streamPath,
            watcherInfo.lastOffset,
            size,
            this.replayMaxBytes
          );
          logger.warn(
            `skipped ${Math.round((start - watcherInfo.lastOffset) / 1024)} KB of output of ${sessionId}: its live stream fell more than ${Math.round(this.replayMaxBytes / 1024)} KB behind`
          );
          watcherInfo.lastOffset = start;
        }
        await forEachCastLine(streamPath, watcherInfo.lastOffset, size, (line, lineEnd) => {
          // Moved line by line: a subscriber joining mid-read replays exactly up to here.
          watcherInfo.lastOffset = lineEnd;
          if (line.trim()) this.broadcastLine(sessionId, line, watcherInfo);
        });
      } while (watcherInfo.readAgain);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // A cleaned-up session: the poll would log this every second until its clients leave.
        logger.debug(`cast of ${sessionId} is gone`);
      } else {
        logger.error(`failed to read file changes for session ${sessionId}:`, error);
      }
    } finally {
      watcherInfo.reading = false;
    }
  }

  private parseAsciinemaLine(line: string): AsciinemaEvent | AsciinemaHeader | null {
    if (!line.trim()) return null;
    try {
      const parsed = JSON.parse(line);
      if (parsed.version && parsed.width && parsed.height) return parsed as AsciinemaHeader;
      if (Array.isArray(parsed)) {
        if (parsed[0] === 'exit') return parsed as AsciinemaExitEvent;
        if (parsed.length >= 3 && typeof parsed[0] === 'number') return parsed as AsciinemaEvent;
      }
      return null;
    } catch {
      return null;
    }
  }

  private broadcastLine(_sessionId: string, line: string, watcherInfo: WatcherInfo): void {
    const parsed = this.parseAsciinemaLine(line);
    if (!parsed) {
      // Treat as raw output line
      for (const client of watcherInfo.clients) {
        client.deliver({ kind: 'output', data: line, historical: false });
      }
      return;
    }

    // Skip headers during live follow (clients already got one from existing content).
    if (!Array.isArray(parsed)) return;

    if (isExitEvent(parsed)) {
      // Nothing follows an exit: the watcher alone notices a restart under the same id.
      clearInterval(watcherInfo.poll);
      watcherInfo.poll = undefined;
      for (const client of watcherInfo.clients) {
        client.deliver({ kind: 'exit', exitCode: parsed[1] });
      }
      return;
    }

    if (isOutputEvent(parsed)) {
      for (const client of watcherInfo.clients) {
        client.deliver({ kind: 'output', data: parsed[2], historical: false });
      }
    } else if (isResizeEvent(parsed)) {
      for (const client of watcherInfo.clients) {
        client.deliver({ kind: 'resize', dimensions: parsed[2], historical: false });
      }
    }
  }

  private processClearSequence(
    event: AsciinemaOutputEvent,
    eventIndex: number,
    fileOffset: number,
    currentResize: AsciinemaResizeEvent | null,
    eventLine: string
  ): {
    lastClearIndex: number;
    lastClearOffset: number;
    lastResizeBeforeClear: AsciinemaResizeEvent | null;
  } | null {
    const prunePoint = findLastPrunePoint(event[2]);
    if (!prunePoint) return null;

    const lastClearOffset = calculatePruningPositionInFile(
      fileOffset,
      eventLine,
      prunePoint.position
    );
    logPruningDetection(prunePoint.sequence, lastClearOffset, '(retroactive scan)');

    return {
      lastClearIndex: eventIndex,
      lastClearOffset,
      lastResizeBeforeClear: currentResize,
    };
  }

  private sendExistingContent(
    sessionId: string,
    streamPath: string,
    endOffset: number,
    useSavedClear: boolean,
    listener: CastOutputHubListener,
    onDone: () => void
  ) {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      onDone();
    };
    const fail = (error: unknown) => {
      logger.error(`failed to send existing cast content for ${sessionId}:`, error);
      listener({ kind: 'error', message: 'Failed to read session output' });
      finish();
    };
    this.replayExistingContent(sessionId, streamPath, endOffset, useSavedClear, listener)
      .then(finish)
      .catch(fail);
  }

  /**
   * Replay the history in [last clear, endOffset): the header, then the events from
   * the last clear on. At most replayMaxBytes of it: a long Claude
   * Code session's 1 GB cast had 430 MB after its last clear, all kept in memory here and
   * queued on the socket (history is exempt from the client buffer limit). A longer history
   * starts on the first whole event line in its last replayMaxBytes, at the terminal size in
   * effect there; a full-screen app's repaints in them draw the current screen. Without
   * `useSavedClear` the session's lastClearOffset is not trusted and the range is scanned.
   */
  private async replayExistingContent(
    sessionId: string,
    streamPath: string,
    endOffset: number,
    useSavedClear: boolean,
    listener: CastOutputHubListener
  ): Promise<void> {
    const sessionInfo = this.sessionManager.loadSessionInfo(sessionId);
    let clearOffset = useSavedClear ? (sessionInfo?.lastClearOffset ?? 0) : 0;
    const size = fs.existsSync(streamPath) ? fs.statSync(streamPath).size : 0;
    if (clearOffset > size) {
      // Saved against a longer cast (a forwarder restarted under the same id truncates it).
      // Clamped to the size it left nothing to replay, and a reconnect showed no history. It says nothing about this file: replay its bounded tail instead.
      logger.warn(
        `ignoring lastClearOffset ${clearOffset} of ${sessionId}: its cast is only ${size} bytes`
      );
      clearOffset = 0;
    }
    clearOffset = Math.min(clearOffset, endOffset);
    // lastClearOffset points inside the event that contains the clear sequence. Start at
    // that event's line so it parses; otherwise the frame drawn right after the clear in
    // the same write (Claude Code does `ESC[2J` + full redraw at once) is lost.
    clearOffset = findLineStart(streamPath, clearOffset);

    // Read header line (best-effort)
    let header: AsciinemaHeader | null = null;
    let fd: number | null = null;
    try {
      fd = fs.openSync(streamPath, 'r');
      const buf = Buffer.alloc(HEADER_READ_BUFFER_SIZE);
      let data = '';
      let filePosition = 0;
      let bytesRead = fs.readSync(fd, buf, 0, buf.length, filePosition);

      while (!data.includes('\n') && bytesRead > 0) {
        data += buf.toString('utf8', 0, bytesRead);
        filePosition += bytesRead;
        if (!data.includes('\n')) {
          bytesRead = fs.readSync(fd, buf, 0, buf.length, filePosition);
        }
      }

      const idx = data.indexOf('\n');
      if (idx !== -1) header = JSON.parse(data.slice(0, idx));
    } catch {
      // ignore
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
      }
    }

    if (endOffset <= clearOffset) {
      // Nothing to replay yet (no file, or nothing after the last clear).
      if (header) listener({ kind: 'header', header });
      return;
    }

    const { start: startOffset, truncated } = await castReplayStart(
      streamPath,
      clearOffset,
      endOffset,
      this.replayMaxBytes
    );
    // The size the terminal had where a cut replay starts: the header's is long gone.
    const sizeAtStart = truncated ? await findLastResizeBefore(streamPath, startOffset) : null;
    if (truncated) {
      logger.log(
        `replaying the last ${Math.round((endOffset - startOffset) / 1024)} KB of ${Math.round((endOffset - clearOffset) / 1024)} KB of history of ${sessionId}`
      );
    }

    const events: AsciinemaEvent[] = [];
    let lastClearIndex = -1;
    const resizeAtStart: AsciinemaResizeEvent | null = sizeAtStart ? [0, 'r', sizeAtStart] : null;
    let currentResize = resizeAtStart;
    let lastResizeBeforeClear: AsciinemaResizeEvent | null = null;
    let lastClearOffset = startOffset;

    const processLine = (line: string, fileOffset: number) => {
      if (!line.trim()) return;

      try {
        const parsed = JSON.parse(line);
        if (parsed.version && parsed.width && parsed.height) {
          header = parsed as AsciinemaHeader;
          return;
        }

        if (!Array.isArray(parsed)) return;

        if (parsed[0] === 'exit') {
          events.push(parsed as AsciinemaExitEvent);
          return;
        }

        if (parsed.length < 3 || typeof parsed[0] !== 'number') return;
        const event = parsed as AsciinemaEvent;

        if (isResizeEvent(event)) currentResize = event;

        if (isOutputEvent(event) && containsPruningSequence(event[2])) {
          const clearResult = this.processClearSequence(
            event as AsciinemaOutputEvent,
            events.length,
            fileOffset,
            currentResize,
            line
          );
          if (clearResult) {
            lastClearIndex = clearResult.lastClearIndex;
            lastClearOffset = clearResult.lastClearOffset;
            lastResizeBeforeClear = clearResult.lastResizeBeforeClear;
          }
        }

        events.push(event);
      } catch {
        // ignore invalid lines
      }
    };

    await forEachCastLine(streamPath, startOffset, endOffset, processLine);

    let startIndex = 0;
    if (lastClearIndex >= 0) {
      // Whatever the clearing event wrote after its last clear sequence is the current
      // screen (Claude Code clears and redraws in one write), so replay that remainder.
      startIndex = lastClearIndex + 1;
      const clearEvent = events[lastClearIndex] as AsciinemaOutputEvent;
      const prunePoint = findLastPrunePoint(clearEvent[2]);
      const remainder = prunePoint ? clearEvent[2].slice(prunePoint.position) : '';
      if (remainder) {
        startIndex = lastClearIndex;
        events[lastClearIndex] = [clearEvent[0], clearEvent[1], remainder];
      }
      // Reload before saving: the stream read may be long and other fields may have been
      // saved meanwhile.
      const latestInfo = this.sessionManager.loadSessionInfo(sessionId);
      if (latestInfo) {
        latestInfo.lastClearOffset = lastClearOffset;
        this.sessionManager.saveSessionInfo(sessionId, latestInfo);
      }
    }

    if (header) {
      const headerToSend = { ...(header as AsciinemaHeader) };
      const sizeEvent = lastClearIndex >= 0 ? lastResizeBeforeClear : resizeAtStart;
      if (sizeEvent) {
        const [w, h] = sizeEvent[2].split('x');
        headerToSend.width = Number.parseInt(w, 10);
        headerToSend.height = Number.parseInt(h, 10);
      }
      listener({ kind: 'header', header: headerToSend });
    }

    for (let i = startIndex; i < events.length; i++) {
      const event = events[i];
      if (isExitEvent(event)) {
        listener({ kind: 'exit', exitCode: event[1] });
      } else if (isOutputEvent(event)) {
        listener({ kind: 'output', data: event[2], historical: true });
      } else if (isResizeEvent(event)) {
        listener({ kind: 'resize', dimensions: event[2], historical: true });
      }
    }
  }

  private cleanup(): void {
    for (const [sessionId] of this.activeWatchers) {
      this.stopWatching(sessionId);
    }
  }
}
