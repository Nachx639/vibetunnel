/**
 * OpenAI Codex CLI chat reader.
 *
 * Like Claude Code, Codex is a full-screen TUI, so the phone chat view reads the conversation
 * from Codex's own rollout instead of the screen. Codex appends every turn to
 * $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local time>-<uuid>.jsonl; its first line is a
 * `session_meta` with the working directory and start time. A VibeTunnel session running
 * `codex` is matched to the newest rollout started in its directory after the session began.
 * The result has the same shape as the Claude chat, so the same chat view renders it.
 * (Codex typed inside a shell is found by codex-process.ts, which passes its cwd and start.)
 *
 * Read-only: nothing here writes, and nothing shells out.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ClaudeChat, ClaudeChatMessage } from './claude-chat.js';
import { diffFromPatch } from './edit-diff.js';

export interface CodexChat extends ClaudeChat {
  agent: 'codex';
}

/** Where Codex keeps its state ($CODEX_HOME, else ~/.codex). */
export function defaultCodexDir(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** Whether a session command runs Codex (`codex`, `/opt/bin/codex …`, `zsh -lc "codex …"`). */
export function isCodexCommand(command: string[] | undefined): boolean {
  if (!Array.isArray(command)) return false;
  return command.some((arg) =>
    arg
      .trim()
      .split(/\s+/)
      .some((word) => word.split('/').pop() === 'codex')
  );
}

const MAX_MESSAGES = 400;
const MAX_CACHED_ROLLOUTS = 20;
const INITIAL_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_READ_BYTES = 8 * 1024 * 1024;
/** session_meta carries Codex's full instructions: bound the first-line read. */
const META_READ_BYTES = 256 * 1024;
/** Codex may stamp its rollout slightly before VibeTunnel records the session start. */
const START_SKEW_MS = 30_000;
/** Without an end-of-turn marker (older Codex), a turn counts as running this long. */
const BUSY_WINDOW_MS = 2 * 60_000;
/** An open turn that wrote nothing for this long is treated as over (Codex was killed). */
const OPEN_TURN_STALE_MS = 15 * 60_000;
const MATCH_RECHECK_MS = 10_000;
const MAX_RESULT_CHARS = 1500;
const MAX_RESULT_LINES = 20;
const TITLE_MAX = 80;

interface RolloutCache {
  offset: number;
  skipPartialLine?: boolean;
  messages: ClaudeChatMessage[];
  tools: Map<string, ClaudeChatMessage>;
  title?: string;
  /** Start of the turn in progress (epoch ms), cleared by task_complete / turn_aborted. */
  openTurnAt?: number;
  /** Whether this rollout has task_started markers (newer Codex). */
  hasTurnMarkers?: boolean;
  /** Time of the last line read. */
  lastAt?: number;
}

const rolloutCache = new Map<string, RolloutCache>();

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

function truncateResult(text: string): string {
  const lines = text.split('\n');
  let result = lines.slice(0, MAX_RESULT_LINES).join('\n');
  if (result.length > MAX_RESULT_CHARS) result = result.slice(0, MAX_RESULT_CHARS);
  return result.length < text.trimEnd().length ? `${result.trimEnd()}\n…` : result.trimEnd();
}

/** Text Codex adds to user turns itself (environment, instructions, image markers). */
function isInjectedUserText(text: string): boolean {
  return /^\s*<[a-z_/]/i.test(text) || /^#\s*AGENTS\.md instructions/.test(text);
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The command line of a shell tool call (`["bash","-lc","ls"]` → `ls`). */
function commandOf(args: Record<string, unknown>): string {
  const command = args.command ?? args.cmd;
  if (typeof command === 'string') return command;
  if (Array.isArray(command)) {
    const words = command.filter((word): word is string => typeof word === 'string');
    if (words.length >= 3 && /^-\w*c$/.test(words[1])) return words.slice(2).join(' ');
    return words.join(' ');
  }
  return '';
}

/**
 * Patches a code-mode script hands to `tools.apply_patch(...)`, as a "…" or `…` literal
 * (exported for tests). Codex can edit through such scripts; without this the chip said only
 * "exec · apply_patch", without the change.
 */
export function execScriptPatches(script: string): string[] {
  const patches: string[] = [];
  for (const match of script.matchAll(
    /tools\.apply_patch\(\s*("(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/g
  )) {
    const literal = match[1];
    if (literal.startsWith('"')) {
      try {
        patches.push(JSON.parse(literal) as string);
      } catch {
        // An escape JSON doesn't know (\x41, \'): leave the chip as it was.
      }
    } else {
      patches.push(literal.slice(1, -1).replace(/\\([`\\$])/g, '$1'));
    }
  }
  return patches;
}

/** Files an apply_patch input touches. */
function patchFiles(patch: string): string[] {
  const files: string[] = [];
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    files.push(match[1].trim());
  }
  return files;
}

function toolMessage(
  id: string,
  timestamp: string | undefined,
  name: string,
  payload: Record<string, unknown>
): ClaudeChatMessage {
  const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
  const base = { id, role: 'tool' as const, timestamp, toolUseId: callId };
  if (name === 'apply_patch') {
    const input = typeof payload.input === 'string' ? payload.input : '';
    const files = patchFiles(input);
    const diff = diffFromPatch(input);
    return {
      ...base,
      tool: 'Edit',
      text: files.map((file) => path.basename(file)).join(', '),
      detail: files.join('\n') || undefined,
      diff: diff?.lines,
      diffMore: diff?.more || undefined,
    };
  }
  if (name === 'exec' && typeof payload.input === 'string') {
    // Code mode: a script calling Codex tools; name it after its first command.
    const script = payload.input;
    const patches = execScriptPatches(script);
    if (patches.length > 0) {
      // A script that edits files is shown as the edit, with its change.
      const patch = patches.join('\n');
      const files = patchFiles(patch);
      const diff = diffFromPatch(patch);
      return {
        ...base,
        tool: 'Edit',
        text: files.map((file) => path.basename(file)).join(', '),
        detail: files.join('\n') || undefined,
        diff: diff?.lines,
        diffMore: diff?.more || undefined,
      };
    }
    const cmd = script.match(/tools\.exec_command\(\s*\{\s*cmd\s*:\s*("(?:[^"\\]|\\.)*")/);
    let command = '';
    try {
      command = cmd ? (JSON.parse(cmd[1]) as string) : '';
    } catch {
      // not a plain string literal
    }
    if (command) {
      return { ...base, tool: 'Bash', text: command, detail: truncate(`$ ${command}`, 400) };
    }
    const used = [...new Set([...script.matchAll(/tools\.(\w+)\(/g)].map((m) => m[1]))];
    return { ...base, tool: 'exec', text: used.join(', '), detail: truncate(script, 400) };
  }
  const args = parseArgs(payload.arguments);
  if (name === 'shell' || name === 'shell_command' || name === 'exec_command') {
    const command = commandOf(args);
    return { ...base, tool: 'Bash', text: command, detail: command ? `$ ${command}` : undefined };
  }
  if (name === 'update_plan') {
    const plan = Array.isArray(args.plan) ? args.plan : [];
    const steps = plan
      .map((step: { step?: unknown; status?: unknown }) =>
        typeof step?.step === 'string'
          ? `${step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '→' : '·'} ${step.step}`
          : ''
      )
      .filter(Boolean);
    return { ...base, tool: 'Plan', text: '', detail: steps.join('\n') || undefined };
  }
  if (name === 'view_image' && typeof args.path === 'string') {
    return { ...base, tool: 'Read', text: path.basename(args.path), detail: args.path };
  }
  const detail = typeof payload.arguments === 'string' ? payload.arguments : '';
  return { ...base, tool: name, text: '', detail: truncate(detail, 400) || undefined };
}

/** Output text and error flag of a tool call output. */
function toolOutput(output: unknown): { text: string; isError: boolean } {
  let text = '';
  if (typeof output === 'string') {
    text = output;
    if (output.startsWith('{')) {
      const parsed = parseArgs(output) as { output?: unknown; metadata?: { exit_code?: unknown } };
      if (typeof parsed.output === 'string') {
        const code = parsed.metadata?.exit_code;
        return {
          text: truncateResult(parsed.output),
          isError: typeof code === 'number' && code !== 0,
        };
      }
    }
  } else if (Array.isArray(output)) {
    text = output
      .map((part: { type?: unknown; text?: unknown }) =>
        part?.type === 'input_text' && typeof part.text === 'string' ? part.text : ''
      )
      .filter(Boolean)
      .join('\n');
  }
  const code = text.match(/^(?:Exit code:|Process exited with code) (\d+)/m);
  const isError = (code ? code[1] !== '0' : false) || /^Script failed/.test(text);
  // Drop Codex's headers ("Exit code: 0\nWall time: …\nOutput:"); code mode nests a second one.
  for (let i = 0; i < 2; i++) {
    const header = text.match(
      /^(?:[A-Z][A-Za-z ]*:.*\n|Script (?:completed|failed)\n|Wall time.*\n|Process (?:exited|running).*\n)*?Output:\n/
    );
    if (!header || header[0].split('\n').length > 8) break;
    text = text.slice(header[0].length);
  }
  return { text: truncateResult(text), isError };
}

/** What one rollout line contributes to the chat (exported for tests). */
export interface CodexLine {
  messages: ClaudeChatMessage[];
  result?: { callId: string; text: string; isError: boolean };
  turn?: 'start' | 'end';
  at?: number;
}

/** Turn one rollout line into chat messages (exported for tests). */
export function parseCodexLine(line: string, index = 0): CodexLine {
  let entry: { timestamp?: unknown; type?: unknown; payload?: Record<string, unknown> };
  try {
    entry = JSON.parse(line);
  } catch {
    return { messages: [] };
  }
  const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;
  const parsedAt = timestamp ? Date.parse(timestamp) : Number.NaN;
  const at = Number.isNaN(parsedAt) ? undefined : parsedAt;
  const payload = entry.payload;
  if (!payload || typeof payload !== 'object') return { messages: [], at };
  const kind = payload.type;
  const id = `${timestamp ?? 'line'}:${index}`;

  if (entry.type === 'event_msg') {
    if (kind === 'task_started') return { messages: [], turn: 'start', at };
    if (kind === 'task_complete' || kind === 'turn_aborted') {
      return {
        messages:
          kind === 'turn_aborted' ? [{ id, role: 'note', text: 'Interrupted', timestamp }] : [],
        turn: 'end',
        at,
      };
    }
    return { messages: [], at };
  }
  if (entry.type !== 'response_item') return { messages: [], at };

  if (kind === 'message') {
    const role = payload.role;
    if (role !== 'user' && role !== 'assistant') return { messages: [], at };
    const parts = Array.isArray(payload.content) ? payload.content : [];
    const texts: string[] = [];
    let images = 0;
    for (const part of parts as Array<{ type?: unknown; text?: unknown }>) {
      if (part?.type === 'input_image') images++;
      if (typeof part?.text !== 'string') continue;
      if (role === 'user' && isInjectedUserText(part.text)) continue;
      texts.push(part.text);
    }
    let text = texts.join('\n').trim();
    if (role === 'user' && !text && images > 0) text = '[Image]';
    if (!text) return { messages: [], at };
    const message: ClaudeChatMessage = { id, role, text, timestamp };
    return { messages: [message], at };
  }
  if (kind === 'function_call' || kind === 'custom_tool_call') {
    const name = typeof payload.name === 'string' ? payload.name : 'tool';
    return { messages: [toolMessage(id, timestamp, name, payload)], at };
  }
  if (kind === 'web_search_call') {
    const action = (payload.action ?? {}) as { query?: unknown; url?: unknown };
    const query = typeof action.query === 'string' ? action.query : '';
    const url = typeof action.url === 'string' ? action.url : '';
    return {
      messages: [
        {
          id,
          role: 'tool',
          tool: url ? 'WebFetch' : 'WebSearch',
          text: url || query,
          timestamp,
          result: '',
        },
      ],
      at,
    };
  }
  if (
    (kind === 'function_call_output' || kind === 'custom_tool_call_output') &&
    typeof payload.call_id === 'string'
  ) {
    return { messages: [], result: { callId: payload.call_id, ...toolOutput(payload.output) }, at };
  }
  return { messages: [], at };
}

function readRollout(rolloutPath: string): RolloutCache {
  const size = fs.statSync(rolloutPath).size;
  let cache = rolloutCache.get(rolloutPath);
  if (cache) {
    rolloutCache.delete(rolloutPath);
    rolloutCache.set(rolloutPath, cache);
  }
  if (!cache || size < cache.offset) {
    const tailStart = Math.max(0, size - INITIAL_TAIL_BYTES);
    cache = { offset: tailStart, messages: [], tools: new Map(), skipPartialLine: tailStart > 0 };
    rolloutCache.set(rolloutPath, cache);
    while (rolloutCache.size > MAX_CACHED_ROLLOUTS) {
      rolloutCache.delete(rolloutCache.keys().next().value as string);
    }
  }
  if (size <= cache.offset) return cache;
  const fd = fs.openSync(rolloutPath, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(size - cache.offset, MAX_READ_BYTES));
    fs.readSync(fd, buffer, 0, buffer.length, cache.offset);
    let start = 0;
    if (cache.skipPartialLine) {
      const firstNewline = buffer.indexOf(0x0a);
      if (firstNewline < 0) {
        cache.offset += buffer.length;
        return cache;
      }
      start = firstNewline + 1;
      cache.skipPartialLine = false;
    }
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline < start) {
      // No complete line yet; an oversized one is skipped.
      if (buffer.length === MAX_READ_BYTES) {
        cache.offset += buffer.length;
        cache.skipPartialLine = true;
      } else {
        cache.offset += start;
      }
      return cache;
    }
    const chunk = buffer.subarray(start, lastNewline).toString('utf8');
    const base = cache.offset + start;
    let lineStart = 0;
    for (const line of chunk.split('\n')) {
      const index = base + lineStart;
      lineStart += Buffer.byteLength(line) + 1;
      if (!line) continue;
      const parsed = parseCodexLine(line, index);
      if (parsed.at !== undefined) cache.lastAt = parsed.at;
      for (const message of parsed.messages) {
        cache.messages.push(message);
        if (message.toolUseId) cache.tools.set(message.toolUseId, message);
        if (!cache.title && message.role === 'user' && message.text !== '[Image]') {
          cache.title = truncate(message.text.replace(/\s+/g, ' ').trim(), TITLE_MAX);
        }
      }
      if (parsed.result) {
        const tool = cache.tools.get(parsed.result.callId);
        if (tool) {
          tool.result = parsed.result.text;
          tool.isError = parsed.result.isError || undefined;
        }
      }
      if (parsed.turn === 'start') {
        cache.hasTurnMarkers = true;
        cache.openTurnAt = parsed.at ?? Date.now();
      }
      if (parsed.turn === 'end') cache.openTurnAt = undefined;
    }
    cache.offset = base + (lastNewline - start) + 1;
    if (cache.messages.length > MAX_MESSAGES) {
      cache.messages = cache.messages.slice(-MAX_MESSAGES);
      const kept = new Set(cache.messages);
      for (const [callId, tool] of cache.tools) if (!kept.has(tool)) cache.tools.delete(callId);
    }
  } finally {
    fs.closeSync(fd);
  }
  return cache;
}

/** "busy" while a turn is open, else "idle". */
function statusOf(cache: RolloutCache, now = Date.now()): 'busy' | 'idle' {
  const lastAt = cache.lastAt ?? 0;
  if (cache.hasTurnMarkers) {
    return cache.openTurnAt !== undefined && now - lastAt < OPEN_TURN_STALE_MS ? 'busy' : 'idle';
  }
  // Older Codex has no turn markers: a fresh prompt or a command still running means busy.
  if (now - lastAt >= BUSY_WINDOW_MS) return 'idle';
  const last = cache.messages[cache.messages.length - 1];
  if (last?.role === 'user') return 'busy';
  if (last?.role === 'tool' && last.result === undefined) return 'busy';
  return 'idle';
}

/** First-line metadata of a rollout: where and when Codex started. */
function readMeta(rolloutPath: string): { cwd: string; startedAt: number } | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(rolloutPath, 'r');
    const buffer = Buffer.alloc(META_READ_BYTES);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, read).toString('utf8');
    const newline = head.indexOf('\n');
    let payload: { cwd?: unknown; timestamp?: unknown } | undefined;
    if (newline >= 0) {
      try {
        const entry = JSON.parse(head.slice(0, newline));
        if (entry?.type === 'session_meta') payload = entry.payload;
      } catch {
        // fall back to the fields at the start of the line
      }
    }
    if (!payload) {
      if (!head.startsWith('{"timestamp"') || !head.includes('"session_meta"')) return null;
      const field = (name: string) => {
        const match = head.match(new RegExp(`"payload":\\{[^]*?"${name}":("(?:[^"\\\\]|\\\\.)*")`));
        try {
          return match ? (JSON.parse(match[1]) as string) : undefined;
        } catch {
          return undefined;
        }
      };
      payload = { cwd: field('cwd'), timestamp: field('timestamp') };
    }
    if (typeof payload.cwd !== 'string' || typeof payload.timestamp !== 'string') return null;
    const startedAt = Date.parse(payload.timestamp);
    return Number.isNaN(startedAt) ? null : { cwd: payload.cwd, startedAt };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const metaCache = new Map<string, { cwd: string; startedAt: number } | null>();

function cachedMeta(rolloutPath: string) {
  if (metaCache.has(rolloutPath)) return metaCache.get(rolloutPath) ?? null;
  const meta = readMeta(rolloutPath);
  // An empty rollout (Codex just created it) gets its first line soon: only cache hits.
  if (meta) metaCache.set(rolloutPath, meta);
  if (metaCache.size > 5000) metaCache.delete(metaCache.keys().next().value as string);
  return meta;
}

const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (date: Date) =>
  `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;

function listDirs(dir: string, pattern: RegExp): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => pattern.test(name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

const realPaths = new Map<string, string>();

/** A directory with symlinks resolved (cached; the path itself if it can't be resolved). */
function realPath(dir: string): string {
  let real = realPaths.get(dir);
  if (real === undefined) {
    try {
      real = fs.realpathSync(dir);
    } catch {
      real = dir;
    }
    if (realPaths.size > 500) realPaths.clear();
    realPaths.set(dir, real);
  }
  return real;
}

/**
 * Newest rollout Codex started in `cwd` at or after `since` (epoch ms), skipping `claimed`
 * ones (rollouts already shown for another session in the same directory).
 */
export function findCodexRollout(
  codexDir: string,
  cwd: string,
  since: number,
  claimed: Set<string> = new Set()
): string | null {
  const sessionsDir = path.join(codexDir, 'sessions');
  // Codex records the real path: on macOS /tmp/x is /private/tmp/x.
  const wanted = realPath(cwd);
  // Day folders use local time; one day of margin covers time zones and midnight.
  const firstDay = dayKey(new Date(since - 24 * 60 * 60 * 1000));
  for (const year of listDirs(sessionsDir, /^\d{4}$/)) {
    if (year < firstDay.slice(0, 4)) break;
    for (const month of listDirs(path.join(sessionsDir, year), /^\d{2}$/)) {
      if (`${year}/${month}` < firstDay.slice(0, 7)) break;
      for (const day of listDirs(path.join(sessionsDir, year, month), /^\d{2}$/)) {
        if (`${year}/${month}/${day}` < firstDay) break;
        const dayDir = path.join(sessionsDir, year, month, day);
        for (const file of listDirs(dayDir, /^rollout-.*\.jsonl$/)) {
          const candidate = path.join(dayDir, file);
          if (claimed.has(candidate)) continue;
          const meta = cachedMeta(candidate);
          if (meta && realPath(meta.cwd) === wanted && meta.startedAt >= since - START_SKEW_MS) {
            return candidate;
          }
        }
      }
    }
  }
  return null;
}

export interface CodexSessionRef {
  id: string;
  workingDir: string;
  startedAt: string;
}

const matches = new Map<
  string,
  { path: string | null; at: number; codexDir: string; key: string }
>();

/** The rollout of a VibeTunnel session, re-checked now and then for a newer conversation. */
function rolloutFor(session: CodexSessionRef, codexDir: string): string | null {
  const cached = matches.get(session.id);
  // A new Codex run in the same shell changes the start time: match again right away.
  const key = `${session.workingDir}\0${session.startedAt}`;
  if (
    cached &&
    cached.codexDir === codexDir &&
    cached.key === key &&
    Date.now() - cached.at < MATCH_RECHECK_MS
  ) {
    return cached.path;
  }
  const since = Date.parse(session.startedAt);
  if (Number.isNaN(since) || !session.workingDir) return null;
  const claimed = new Set<string>();
  for (const [id, match] of matches) if (id !== session.id && match.path) claimed.add(match.path);
  const found = findCodexRollout(codexDir, session.workingDir, since, claimed);
  matches.delete(session.id);
  matches.set(session.id, { path: found, at: Date.now(), codexDir, key });
  if (matches.size > 200) matches.delete(matches.keys().next().value as string);
  return found;
}

/** Forget a session's rollout match (it exited). */
export function forgetCodexSession(sessionId: string) {
  matches.delete(sessionId);
}

/** The Codex conversation of a running VibeTunnel session. */
export function readCodexChat(session: CodexSessionRef, codexDir = defaultCodexDir()): CodexChat {
  const rolloutPath = rolloutFor(session, codexDir);
  if (!rolloutPath) {
    // Codex writes its rollout with the first prompt: a chat, empty for now.
    return { available: true, agent: 'codex', status: 'idle', messages: [] };
  }
  let rollout: RolloutCache;
  try {
    rollout = readRollout(rolloutPath);
  } catch {
    matches.delete(session.id);
    return { available: true, agent: 'codex', status: 'idle', messages: [] };
  }
  const status = statusOf(rollout);
  const last = rollout.messages[rollout.messages.length - 1];
  return {
    available: true,
    agent: 'codex',
    status,
    title: rollout.title,
    activity:
      status === 'busy'
        ? last?.role === 'tool' && last.result === undefined
          ? {
              kind: 'tool',
              tool: last.tool,
              target: last.text ? truncate(last.text.replace(/\s+/g, ' '), 60) : undefined,
              since: last.timestamp ? Date.parse(last.timestamp) : undefined,
            }
          : { kind: 'thinking', since: rollout.lastAt }
        : undefined,
    messages: rollout.messages,
  };
}
