/**
 * Bounded reads of asciinema cast files (a session's `stdout`).
 *
 * A long Claude Code session (fullscreen TUI, constant repaints) grew its cast to 1 GB. The
 * server read whole casts into one string, which V8 caps at 0x1fffffe8 characters: "Cannot
 * create a string longer than 0x1fffffe8 characters" when its terminal was built, then
 * "Invalid string length" in the fallback snapshot, so /text and buffer snapshots had no
 * screen for that session. The client replay streamed the file but kept every
 * event since the last clear (430 MB there) in memory and queued it all on the WebSocket.
 *
 * A screen is rebuilt from the end of the recording: a full-screen app's last repaints draw
 * all of it. These helpers read only the last few MB, starting on a line (one JSON event)
 * boundary, plus the header line read on its own, and stream them with backpressure.
 */
import * as fs from 'fs';

/** Bytes of a cast replayed at most to rebuild a screen (server terminal, client replay). */
export const CAST_REPLAY_MAX_BYTES = 16 * 1024 * 1024;

/** How far back from a cut replay to look for the terminal size in effect there. */
export const RESIZE_LOOKBACK_MAX_BYTES = 128 * 1024 * 1024;

const SCAN_CHUNK_BYTES = 64 * 1024;
const RESIZE_SCAN_CHUNK_BYTES = 1024 * 1024;
const MAX_HEADER_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;
// `[1.5,"r","80x24"]`: inside an event's data every quote is escaped, so this only matches
// the type field of a resize event.
const RESIZE_MARKER = Buffer.from(',"r","');

/** Offset of the start of the line containing `offset` (0 if none found). */
export function findLineStart(filePath: string, offset: number): number {
  if (offset <= 0) return 0;
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const chunk = Buffer.alloc(SCAN_CHUNK_BYTES);
    let end = offset;
    while (end > 0) {
      const start = Math.max(0, end - chunk.length);
      const bytesRead = fs.readSync(fd, chunk, 0, end - start, start);
      const newline = chunk.subarray(0, bytesRead).lastIndexOf(NEWLINE);
      if (newline !== -1) return start + newline + 1;
      end = start;
    }
    return 0;
  } catch {
    return offset;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** The first offset at or after `offset` that starts a line, or `limit` if none is before it. */
export async function findNextLineStart(
  filePath: string,
  offset: number,
  limit: number
): Promise<number> {
  if (offset <= 0) return 0;
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const chunk = Buffer.alloc(SCAN_CHUNK_BYTES);
    // From the byte before: when it is a newline, `offset` itself starts a line.
    let position = offset - 1;
    while (position < limit) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, limit - position),
        position
      );
      if (bytesRead === 0) break;
      const newline = chunk.subarray(0, bytesRead).indexOf(NEWLINE);
      if (newline !== -1) return Math.min(position + newline + 1, limit);
      position += bytesRead;
    }
    return limit;
  } finally {
    await handle.close();
  }
}

/** The cast's first line (its header) and the offset just after it, if it is complete. */
export async function readCastHeaderLine(
  filePath: string
): Promise<{ line: string; end: number } | null> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const chunk = Buffer.alloc(SCAN_CHUNK_BYTES);
    const parts: Buffer[] = [];
    let position = 0;
    while (position < MAX_HEADER_BYTES) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) return null;
      const newline = chunk.subarray(0, bytesRead).indexOf(NEWLINE);
      if (newline !== -1) {
        parts.push(Buffer.from(chunk.subarray(0, newline)));
        return { line: Buffer.concat(parts).toString('utf8'), end: position + newline + 1 };
      }
      parts.push(Buffer.from(chunk.subarray(0, bytesRead)));
      position += bytesRead;
    }
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Where to start replaying the events in [from, to) so that at most `maxBytes` are read:
 * `from` when they fit; otherwise `preferred` (the line of the last clear) when it is inside
 * the last `maxBytes`, else the first line that starts in them.
 */
export async function castReplayStart(
  filePath: string,
  from: number,
  to: number,
  maxBytes: number,
  preferred?: number
): Promise<{ start: number; truncated: boolean }> {
  if (to - from <= maxBytes) return { start: from, truncated: false };
  const cut = to - maxBytes;
  if (preferred !== undefined && preferred >= cut && preferred < to) {
    return { start: Math.max(from, findLineStart(filePath, preferred)), truncated: true };
  }
  return { start: await findNextLineStart(filePath, cut, to), truncated: true };
}

/**
 * The dimensions ("COLSxROWS") of the last resize event before `offset`, looking back at most
 * `lookback` bytes and never before `stopAt`. Null when there is none in that range.
 */
export async function findLastResizeBefore(
  filePath: string,
  offset: number,
  stopAt = 0,
  lookback = RESIZE_LOOKBACK_MAX_BYTES
): Promise<string | null> {
  const floor = Math.max(stopAt, offset - lookback);
  if (offset <= floor) return null;
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const chunk = Buffer.alloc(RESIZE_SCAN_CHUNK_BYTES);
    const tail = Buffer.alloc(32);
    let end = offset;
    while (end > floor) {
      const start = Math.max(floor, end - chunk.length);
      const { bytesRead } = await handle.read(chunk, 0, end - start, start);
      const view = chunk.subarray(0, bytesRead);
      for (let at = view.lastIndexOf(RESIZE_MARKER); at !== -1; ) {
        const { bytesRead: tailRead } = await handle.read(
          tail,
          0,
          tail.length,
          start + at + RESIZE_MARKER.length
        );
        const match = tail.toString('latin1', 0, tailRead).match(/^(\d+x\d+)"\]/);
        if (match) return match[1];
        at = at > 0 ? view.lastIndexOf(RESIZE_MARKER, at - 1) : -1;
      }
      if (start <= floor) break;
      // Overlap so a marker across the chunk boundary is still found.
      end = start + RESIZE_MARKER.length - 1;
    }
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Stream the complete lines in [start, end) to `onLine`, reading with backpressure (the next
 * chunk is read only after this one's lines were handled). Lines are cut on the newline byte,
 * which never occurs inside a UTF-8 sequence, so a character split across chunks stays whole.
 * Returns the offset after the last complete line: a trailing partial line is left for later.
 */
export async function forEachCastLine(
  filePath: string,
  start: number,
  end: number,
  onLine: (line: string, lineEnd: number) => void
): Promise<number> {
  if (end <= start) return start;
  const stream = fs.createReadStream(filePath, {
    start,
    end: end - 1,
    highWaterMark: 256 * 1024,
  });
  let offset = start; // where `pending` starts in the file
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  for await (const data of stream) {
    const chunk = data as Buffer;
    let from = 0;
    let newline = chunk.indexOf(NEWLINE);
    while (newline !== -1) {
      const piece = chunk.subarray(from, newline);
      const lineBytes = pending.length > 0 ? Buffer.concat([...pending, piece]) : piece;
      const lineEnd = offset + pendingBytes + (newline - from) + 1;
      pending = [];
      pendingBytes = 0;
      offset = lineEnd;
      onLine(lineBytes.toString('utf8'), lineEnd);
      from = newline + 1;
      newline = chunk.indexOf(NEWLINE, from);
    }
    if (from < chunk.length) {
      pending.push(Buffer.from(chunk.subarray(from)));
      pendingBytes += chunk.length - from;
    }
  }
  return offset;
}
