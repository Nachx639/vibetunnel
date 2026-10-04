/**
 * Claude Code chat transcript reader.
 *
 * Claude Code is a full-screen TUI: the terminal only ever holds the visible screen, so
 * the phone chat view reads the conversation from Claude Code's own transcript instead.
 * A running `claude` process writes <Claude dir>/sessions/<pid>.json (sessionId, cwd,
 * status) and appends the conversation to <Claude dir>/projects/<cwd slug>/<sessionId>.jsonl;
 * the Claude dir is CLAUDE_CONFIG_DIR, else ~/.claude.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { claudeConfigDir } from '../utils/claude-dir.js';
import { diffForToolUse } from './edit-diff.js';

const execFileAsync = promisify(execFile);

export type ClaudeChatRole = 'user' | 'assistant' | 'tool' | 'note';

export interface ClaudeChatMessage {
  id: string;
  role: ClaudeChatRole;
  text: string;
  timestamp?: string;
  /** Tool name for role "tool" (e.g. "Bash", "Edit"). */
  tool?: string;
  /** AskUserQuestion with a single single-choice question: answerable by its option number. */
  question?: { text: string; options: string[] };
  /** Tool call detail shown when the chip is expanded (command, file, pattern…). */
  detail?: string;
  /** Start of the tool's output, attached when its result arrives. */
  result?: string;
  isError?: boolean;
  toolUseId?: string;
  /** Edit/MultiEdit/Write: the change as signed lines ('-', '+', ' ') or DIFF_GAP. */
  diff?: string[];
  /** Diff lines left out past the ones in `diff`. */
  diffMore?: number;
}

export interface ClaudeChat {
  available: boolean;
  /** Claude Code's own status: "idle", "busy" or "waiting". */
  status?: string;
  /** What Claude Code waits for when status is "waiting" (e.g. a permission dialog). */
  waitingFor?: string;
  /** Title Claude Code generated for the conversation. */
  title?: string;
  /** While busy: what Claude is doing right now. */
  activity?: ClaudeActivity;
  /**
   * Busy, but the reply is over: Claude Code stays "busy" while background agents or tasks
   * run, so this tells "waiting for background work" apart from a turn still in progress.
   */
  waitingForBackground?: boolean;
  messages: ClaudeChatMessage[];
}

interface ClaudeSessionFile {
  sessionId?: string;
  cwd?: string;
  status?: string;
  waitingFor?: string;
  /** Epoch ms of the last status change (Claude Code writes it with the status). */
  statusUpdatedAt?: number;
}

interface TranscriptCache {
  offset: number;
  messages: ClaudeChatMessage[];
  /** Tool calls by tool_use id, to attach their results when those lines arrive. */
  tools: Map<string, ClaudeChatMessage>;
  title?: string;
  /** The read position is mid-line (tail start or an oversized line): skip to the next line. */
  skipPartialLine?: boolean;
  /** Last step Claude took in the conversation, for the live activity line. */
  lastStep?: TranscriptStep;
  /** The latest prompt's id and its text message, to add the images that follow it. */
  lastPrompt?: { promptId?: string; index: number };
  /** The main thread's last turn ended (and when): nothing has started another since. */
  turnEnded?: TurnEnd;
}

/** A finished turn of the main thread: `at` is when its reply ended (epoch ms). */
interface TurnEnd {
  at?: number;
}

/** What the end of the transcript says Claude is doing. */
type TranscriptStep =
  | { kind: 'thinking' | 'writing'; at?: number }
  | { kind: 'tool'; tool: ClaudeChatMessage };

/** Live activity of a working Claude: structured, the client words it in its own language. */
export interface ClaudeActivity {
  /** "thinking", "writing" or "tool". */
  kind: 'thinking' | 'writing' | 'tool';
  /** Tool name while a tool call has no result yet (e.g. "Bash", "Edit"). */
  tool?: string;
  /** Short subject of the tool call: command, file name, pattern, host… (≤ 60 chars). */
  target?: string;
  /** When this step began (epoch ms). */
  since?: number;
}

const MAX_MESSAGES = 400;
const MAX_CACHED_TRANSCRIPTS = 20;
/** First read of a transcript only looks at its end. */
const INITIAL_TAIL_BYTES = 4 * 1024 * 1024;
/** Upper bound for one synchronous read during a poll. */
const MAX_READ_BYTES = 8 * 1024 * 1024;
const transcriptCache = new Map<string, TranscriptCache>();

export interface ProcessTable {
  children: Map<number, number[]>;
  /** `ps` lstart per pid, normalized; matches Claude Code's procStart. */
  starts: Map<number, string>;
  /** Command line per pid (`ps` args), to spot agents started inside a shell. */
  args: Map<number, string>;
}

let processCache: { at: number; table: ProcessTable } | null = null;

const normalizeStart = (start: string) => start.trim().replace(/\s+/g, ' ');

let processTableInFlight: Promise<ProcessTable> | null = null;

/** Process tree and start times, shared for a couple of seconds across requests. */
export async function processTable(): Promise<ProcessTable> {
  if (processCache && Date.now() - processCache.at < 2000) return processCache.table;
  // Concurrent requests (several clients polling /sessions) share one `ps` run.
  processTableInFlight ??= readProcessTable()
    .then((table) => {
      processCache = { at: Date.now(), table };
      return table;
    })
    .finally(() => {
      processTableInFlight = null;
    });
  return processTableInFlight;
}

async function runPs(): Promise<string> {
  // Claude Code records procStart as `ps` lstart in UTC; local time never matches.
  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=,lstart=,args='], {
    env: { ...process.env, TZ: 'UTC' },
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

/**
 * One `ps` of every process. Arguments are never logged: they can hold prompts and secrets.
 * `run` is for tests.
 */
export async function readProcessTable(run: () => Promise<string> = runPs): Promise<ProcessTable> {
  return parseProcessTable(await run());
}

/** `ps -o pid=,ppid=,lstart=,args=` output as a table (exported for tests). */
export function parseProcessTable(stdout: string): ProcessTable {
  const children = new Map<number, number[]>();
  const starts = new Map<number, string>();
  const args = new Map<number, string>();
  for (const line of stdout.split('\n')) {
    // lstart is always five words ("Thu Oct  2 10:00:00 2026"); args follow.
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)(?:\s+(.*))?$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
    starts.set(pid, normalizeStart(match[3]));
    if (match[4]) args.set(pid, match[4].trim());
  }
  return { children, starts, args };
}

/** All descendants of `rootPid` in `table` (breadth first), including itself. */
export function descendants(table: Pick<ProcessTable, 'children'>, rootPid: number): number[] {
  const { children } = table;
  const result: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0 && result.length < 200) {
    const pid = queue.shift() as number;
    result.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return result;
}

async function processTree(rootPid: number): Promise<number[]> {
  return descendants(await processTable(), rootPid);
}

/** A Claude Code conversation id (a UUID): it names the transcript file. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function readSessionFile(
  claudeDir: string,
  pid: number,
  starts: Map<number, string>
): ClaudeSessionFile | null {
  let session: ClaudeSessionFile & { procStart?: string };
  try {
    session = JSON.parse(fs.readFileSync(path.join(claudeDir, 'sessions', `${pid}.json`), 'utf8'));
  } catch {
    return null;
  }
  if (
    typeof session.cwd !== 'string' ||
    typeof session.sessionId !== 'string' ||
    !SESSION_ID.test(session.sessionId)
  ) {
    // Hand-edited or future-format files: never let a bad field throw out of a poll, and
    // never let a session id name a file outside the projects folder ("../x").
    session = {
      ...session,
      cwd: undefined as unknown as string,
      sessionId: undefined as unknown as string,
    };
  }
  // A file left by a crashed claude must not be attributed to a new process reusing its pid.
  const started = starts.get(pid);
  if (session.procStart && started && normalizeStart(session.procStart) !== started) return null;
  return session;
}

const transcriptLookups = new Map<string, { at: number; path: string | null }>();
/** A transcript appears with Claude's first message; until then re-scan at most this often. */
const MISSING_TRANSCRIPT_RECHECK_MS = 5000;

/** findTranscript, cached: the fallback scan walks every project directory synchronously. */
function cachedFindTranscript(claudeDir: string, cwd: string, sessionId: string): string | null {
  const key = `${claudeDir}\0${cwd}\0${sessionId}`;
  const cached = transcriptLookups.get(key);
  if (cached?.path && fs.existsSync(cached.path)) return cached.path;
  if (cached && !cached.path && Date.now() - cached.at < MISSING_TRANSCRIPT_RECHECK_MS) return null;
  const found = findTranscript(claudeDir, cwd, sessionId);
  transcriptLookups.set(key, { at: Date.now(), path: found });
  if (transcriptLookups.size > 200) {
    transcriptLookups.delete(transcriptLookups.keys().next().value as string);
  }
  return found;
}

function findTranscript(claudeDir: string, cwd: string, sessionId: string): string | null {
  const projectsDir = path.join(claudeDir, 'projects');
  const direct = path.join(projectsDir, cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // no projects dir
  }
  return null;
}

function summarizeToolUse(name: string, input: Record<string, unknown> | undefined): string {
  const str = (key: string) => (typeof input?.[key] === 'string' ? (input[key] as string) : '');
  const file = str('file_path') || str('notebook_path') || str('path');
  switch (name) {
    case 'Bash':
      return str('description') || str('command');
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return file ? path.basename(file) : '';
    case 'Grep':
    case 'Glob':
      return str('pattern');
    case 'WebFetch':
      return str('url');
    case 'WebSearch':
      return str('query');
    case 'Agent':
    case 'Task':
      return str('description');
    default:
      return str('description');
  }
}

function singleChoiceQuestion(
  input: Record<string, unknown> | undefined
): ClaudeChatMessage['question'] | undefined {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  if (questions.length !== 1) return undefined;
  const [question] = questions as Array<{
    question?: unknown;
    multiSelect?: unknown;
    options?: Array<{ label?: unknown }>;
  }>;
  if (question.multiSelect || typeof question.question !== 'string') return undefined;
  const options = (question.options ?? [])
    .map((option) => option.label)
    .filter((label): label is string => typeof label === 'string');
  return options.length > 0 ? { text: question.question, options } : undefined;
}

const MAX_RESULT_CHARS = 1500;
const MAX_RESULT_LINES = 20;

function detailForToolUse(name: string, input: Record<string, unknown> | undefined): string {
  const str = (key: string) => (typeof input?.[key] === 'string' ? (input[key] as string) : '');
  switch (name) {
    case 'Bash':
      return str('command') ? `$ ${str('command')}` : '';
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return str('file_path') || str('notebook_path');
    case 'Grep':
      return [str('pattern'), str('path') && `in ${str('path')}`].filter(Boolean).join(' ');
    case 'Glob':
      return str('pattern');
    case 'WebFetch':
      return str('url');
    case 'WebSearch':
      return str('query');
    case 'Agent':
    case 'Task':
      return str('prompt').slice(0, 400);
    default:
      return input ? JSON.stringify(input).slice(0, 400) : '';
  }
}

function truncateResult(text: string): string {
  const lines = text.split('\n');
  let result = lines.slice(0, MAX_RESULT_LINES).join('\n');
  if (result.length > MAX_RESULT_CHARS) result = result.slice(0, MAX_RESULT_CHARS);
  return result.length < text.length ? `${result.trimEnd()}\n…` : result;
}

/** Tool results carried by a user transcript line (exported for tests). */
export function parseToolResults(
  line: string
): Array<{ toolUseId: string; text: string; isError: boolean }> {
  let entry: { type?: string; message?: { content?: unknown } };
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  const content = entry.type === 'user' ? entry.message?.content : undefined;
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block?.type === 'tool_result' && typeof block.tool_use_id === 'string')
    .map((block) => {
      const raw = block.content;
      const text =
        typeof raw === 'string'
          ? raw
          : Array.isArray(raw)
            ? raw
                .filter((part: { type?: string }) => part?.type === 'text')
                .map((part: { text?: string }) => part.text ?? '')
                .join('\n')
            : '';
      return {
        toolUseId: block.tool_use_id,
        text: truncateResult(text),
        isError: !!block.is_error,
      };
    });
}

/** Strip Claude Code's own markup from user text; null when nothing human-written is left. */
function cleanUserText(text: string): string | null {
  const command = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (command) {
    const args = text.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim();
    return args ? `${command[1]} ${args}` : command[1];
  }
  if (/^\s*<(local-command|system-reminder|command-message|bash-|task-notification)/.test(text)) {
    return null;
  }
  const cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  return cleaned || null;
}

/** An image uploaded through VibeTunnel (same names as the files route accepts). */
const UPLOADED_IMAGE_PATH =
  /\/uploads\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:png|jpe?g|gif|webp|heic|heif)$/i;

/**
 * Claude Code takes an image path out of the prompt text, sends the image, and logs where it
 * came from in a separate meta line: `[Image: source: /path]`. Returns the uploaded images
 * named by such a line (exported for tests), so the chat can show them with their prompt
 * (without this, a photo sent from the phone never appeared in the chat).
 */
export function parseImageSources(
  line: string
): { id: string; promptId?: string; timestamp?: string; paths: string[] } | null {
  if (!line.includes('[Image: source: ')) return null;
  let entry: {
    type?: string;
    uuid?: string;
    promptId?: string;
    timestamp?: string;
    isMeta?: boolean;
    isSidechain?: boolean;
    message?: { content?: unknown };
  };
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (entry.type !== 'user' || !entry.isMeta || entry.isSidechain) return null;
  const content = entry.message?.content;
  const texts =
    typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? content.flatMap((b: { type?: string; text?: unknown }) =>
            b?.type === 'text' && typeof b.text === 'string' ? [b.text] : []
          )
        : [];
  const paths = texts.flatMap((text) => {
    const match = text.trim().match(/^\[Image: source: (.+)\]$/);
    return match && UPLOADED_IMAGE_PATH.test(match[1]) ? [match[1]] : [];
  });
  if (paths.length === 0) return null;
  return {
    id: entry.uuid ?? `images-${entry.timestamp}`,
    promptId: entry.promptId,
    timestamp: entry.timestamp,
    paths,
  };
}

/** Add images logged after a prompt to that prompt's message (or show them on their own). */
function attachImageSources(
  cache: TranscriptCache,
  images: NonNullable<ReturnType<typeof parseImageSources>>
) {
  const prompt = cache.lastPrompt;
  const target = prompt ? cache.messages[prompt.index] : undefined;
  if (target?.role === 'user' && prompt?.promptId && prompt.promptId === images.promptId) {
    // A new object and id, so a client that already showed the text sees the change.
    cache.messages[prompt.index] = {
      ...target,
      id: `${target.id}+${images.id}`,
      text: `${images.paths.join(' ')}\n${target.text}`,
    };
    return;
  }
  cache.messages.push({
    id: images.id,
    role: 'user',
    text: images.paths.join(' '),
    timestamp: images.timestamp,
  });
  cache.lastPrompt = { promptId: images.promptId, index: cache.messages.length - 1 };
}

/** Turn one transcript line into chat messages (exported for tests). */
export function parseTranscriptLine(line: string): ClaudeChatMessage[] {
  let entry: {
    type?: string;
    uuid?: string;
    timestamp?: string;
    isSidechain?: boolean;
    isMeta?: boolean;
    message?: { content?: unknown };
  };
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  if ((entry.type !== 'user' && entry.type !== 'assistant') || entry.isSidechain || entry.isMeta) {
    return [];
  }

  const id = entry.uuid ?? `${entry.type}-${entry.timestamp}`;
  const timestamp = entry.timestamp;
  const content = entry.message?.content;
  const blocks: Array<{
    type?: string;
    text?: string;
    name?: string;
    input?: unknown;
    id?: string;
  }> =
    typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : Array.isArray(content)
        ? content
        : [];

  const messages: ClaudeChatMessage[] = [];
  blocks.forEach((block, index) => {
    const blockId = `${id}:${index}`;
    if (block.type === 'text' && typeof block.text === 'string') {
      if (entry.type === 'user' && /^\[Request interrupted by user/.test(block.text)) {
        messages.push({ id: blockId, role: 'note', text: 'Interrupted', timestamp });
        return;
      }
      const text = entry.type === 'user' ? cleanUserText(block.text) : block.text.trim();
      if (text) messages.push({ id: blockId, role: entry.type as ClaudeChatRole, text, timestamp });
    } else if (entry.type === 'assistant' && block.type === 'tool_use' && block.name) {
      const input = block.input as Record<string, unknown> | undefined;
      const diff = diffForToolUse(block.name, input);
      messages.push({
        id: blockId,
        role: 'tool',
        tool: block.name,
        text: summarizeToolUse(block.name, input),
        timestamp,
        question: block.name === 'AskUserQuestion' ? singleChoiceQuestion(input) : undefined,
        detail: detailForToolUse(block.name, input) || undefined,
        toolUseId: block.id,
        diff: diff?.lines,
        diffMore: diff?.more || undefined,
      });
    }
  });
  return messages;
}

function readTranscript(transcriptPath: string): TranscriptCache {
  const size = fs.statSync(transcriptPath).size;
  let cache = transcriptCache.get(transcriptPath);
  if (cache) {
    // Keep the map in least-recently-used order.
    transcriptCache.delete(transcriptPath);
    transcriptCache.set(transcriptPath, cache);
  }
  if (!cache || size < cache.offset) {
    // Transcripts with pasted images can be huge: start from the tail, not the beginning.
    const tailStart = Math.max(0, size - INITIAL_TAIL_BYTES);
    cache = { offset: tailStart, messages: [], tools: new Map(), skipPartialLine: tailStart > 0 };
    transcriptCache.set(transcriptPath, cache);
    while (transcriptCache.size > MAX_CACHED_TRANSCRIPTS) {
      transcriptCache.delete(transcriptCache.keys().next().value as string);
    }
  }
  if (size > cache.offset) {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      // Bounded reads keep each poll from blocking the server on a large backlog.
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
      // Only consume complete lines; the writer may be mid-append.
      const lastNewline = buffer.lastIndexOf(0x0a);
      if (lastNewline < start && buffer.length === MAX_READ_BYTES) {
        // A single line longer than the read window (e.g. a huge pasted image): skip it.
        cache.offset += buffer.length;
        cache.skipPartialLine = true;
      } else if (lastNewline < start) {
        // Skipped the partial line; no complete line after it yet.
        cache.offset += start;
      } else {
        cache.offset += start;
        const chunk = buffer.subarray(start, lastNewline).toString('utf8');
        for (const line of chunk.split('\n')) {
          if (!line) continue;
          if (line.includes('"ai-title"')) {
            try {
              const entry = JSON.parse(line) as { type?: string; aiTitle?: unknown };
              if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string') {
                cache.title = entry.aiTitle;
              }
            } catch {
              // not a complete JSON line
            }
          }
          const images = parseImageSources(line);
          if (images) attachImageSources(cache, images);
          const messages = parseTranscriptLine(line);
          for (const message of messages) {
            cache.messages.push(message);
            if (message.toolUseId) cache.tools.set(message.toolUseId, message);
            if (message.role === 'user') {
              cache.lastPrompt = {
                promptId: line.match(/"promptId":"([^"]+)"/)?.[1],
                index: cache.messages.length - 1,
              };
            }
          }
          const results = parseToolResults(line);
          for (const result of results) {
            const tool = cache.tools.get(result.toolUseId);
            if (tool) {
              tool.result = result.text;
              tool.isError = result.isError;
            }
          }
          cache.lastStep = nextStep(
            cache.lastStep,
            line,
            messages,
            results.length > 0,
            cache.messages
          );
          cache.turnEnded = turnAfter(cache.turnEnded, line);
        }
        cache.offset += lastNewline - start + 1;
        if (cache.messages.length > MAX_MESSAGES) {
          const dropped = cache.messages.length - MAX_MESSAGES;
          cache.messages = cache.messages.slice(-MAX_MESSAGES);
          if (cache.lastPrompt) {
            cache.lastPrompt =
              cache.lastPrompt.index >= dropped
                ? { ...cache.lastPrompt, index: cache.lastPrompt.index - dropped }
                : undefined;
          }
          const kept = new Set(cache.messages);
          for (const [toolUseId, tool] of cache.tools) {
            if (!kept.has(tool)) cache.tools.delete(toolUseId);
          }
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  return cache;
}

function lineTime(line: string): number | undefined {
  const match = line.match(/"timestamp":"([^"]+)"/);
  const at = match ? Date.parse(match[1]) : Number.NaN;
  return Number.isNaN(at) ? undefined : at;
}

/** The step a transcript line moves Claude to (lines with nothing to say keep the last one). */
function nextStep(
  previous: TranscriptStep | undefined,
  line: string,
  messages: ClaudeChatMessage[],
  hasResults: boolean,
  conversation: ClaudeChatMessage[]
): TranscriptStep | undefined {
  const last = messages[messages.length - 1];
  if (last?.role === 'tool') return { kind: 'tool', tool: last };
  if (last?.role === 'assistant') return { kind: 'writing', at: lineTime(line) };
  if (hasResults) {
    // Parallel calls resolve one by one: show one still running, if any.
    for (let i = conversation.length - 1; i >= 0 && conversation[i].role === 'tool'; i--) {
      if (conversation[i].result === undefined) return { kind: 'tool', tool: conversation[i] };
    }
  }
  // A prompt or a tool result: Claude is working out what to do next.
  if (last?.role === 'user' || hasResults) return { kind: 'thinking', at: lineTime(line) };
  // Thinking blocks are not chat messages; a cheap check avoids parsing every line again.
  if (line.includes('"type":"thinking"') && line.includes('"type":"assistant"')) {
    return { kind: 'thinking', at: lineTime(line) };
  }
  return previous;
}

/**
 * User entries that Claude Code writes without starting a turn: a local slash command and its
 * output (`/model`, `/effort`), a `!` shell command. A skill's `<command-message>` line is
 * followed by its prompt as a meta entry, and that one does start the turn.
 */
const NOT_A_TURN =
  /^\s*<(command-name|command-message|local-command-|bash-input|bash-stdout|bash-stderr)/;

/** The text a user entry starts with, if any. */
function userText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const first = content[0] as { type?: string; text?: unknown } | undefined;
  return first?.type === 'text' && typeof first.text === 'string' ? first.text : undefined;
}

/**
 * Whether the main thread's turn is over after a transcript line. Claude Code keeps its
 * status "busy" for as long as any background agent or task runs, even after its reply; the
 * session file can't tell the two apart, so the transcript does (otherwise the phone said
 * "Working…" for an hour while Claude was waiting for the user). The turn is over at a main
 * thread reply that ended with `end_turn` (or an interrupt), and open again at anything that
 * starts one: a prompt, a peer or task-notification message, a tool result, a queued command.
 * Subagent (sidechain) entries and bookkeeping lines leave it as it was.
 */
function turnAfter(previous: TurnEnd | undefined, line: string): TurnEnd | undefined {
  // Most lines are bookkeeping (titles, modes, hooks): skip them without parsing.
  if (
    !line.includes('"type":"assistant"') &&
    !line.includes('"type":"user"') &&
    !line.includes('"queued_command"')
  ) {
    return previous;
  }
  let entry: {
    type?: string;
    isSidechain?: boolean;
    timestamp?: string;
    attachment?: { type?: string };
    message?: { stop_reason?: unknown; content?: unknown };
  };
  try {
    entry = JSON.parse(line);
  } catch {
    return previous;
  }
  if (entry.isSidechain) return previous;
  const at = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
  const ended = { at: Number.isNaN(at) ? undefined : at };
  if (entry.type === 'assistant') {
    return entry.message?.stop_reason === 'end_turn' ? ended : undefined;
  }
  if (entry.type === 'user') {
    const text = userText(entry.message?.content);
    if (text !== undefined && /^\[Request interrupted by user/.test(text)) return ended;
    if (text !== undefined && NOT_A_TURN.test(text)) return previous;
    return undefined;
  }
  if (entry.type === 'attachment' && entry.attachment?.type === 'queued_command') return undefined;
  return previous;
}

/** Whether these transcript lines end with the main thread's turn over (exported for tests). */
export function turnEndedFromLines(lines: string[]): boolean {
  let turn: TurnEnd | undefined;
  for (const line of lines) turn = turnAfter(turn, line);
  return turn !== undefined;
}

/**
 * Busy only because of background work: the turn ended after Claude became busy. A turn that
 * ended before then is the previous one, still the transcript's tail for a moment after a new
 * prompt (and up to PREVIEW_TTL_MS in the cached summaries).
 */
function waitingForBackground(session: ClaudeSessionFile, turnEnded: TurnEnd | undefined): boolean {
  if (session.status !== 'busy' || !turnEnded) return false;
  const busySince = session.statusUpdatedAt;
  return typeof busySince !== 'number' || turnEnded.at === undefined || turnEnded.at >= busySince;
}

const ACTIVITY_TARGET_MAX = 60;

function activityTarget(tool: ClaudeChatMessage): string | undefined {
  let target = tool.text;
  if (tool.tool === 'WebFetch' && target) {
    try {
      target = new URL(target).host || target;
    } catch {
      // not a URL: keep the text
    }
  }
  if (tool.tool === 'TodoWrite') return undefined;
  target = target.replace(/\s+/g, ' ').trim();
  if (!target) return undefined;
  return target.length > ACTIVITY_TARGET_MAX
    ? `${target.slice(0, ACTIVITY_TARGET_MAX - 1)}…`
    : target;
}

function activityOf(step: TranscriptStep | undefined): ClaudeActivity | undefined {
  if (!step) return undefined;
  if (step.kind !== 'tool') return { kind: step.kind, since: step.at };
  const at = step.tool.timestamp ? Date.parse(step.tool.timestamp) : Number.NaN;
  const since = Number.isNaN(at) ? undefined : at;
  // The result arrived but no later line yet (should not last): Claude reads it.
  if (step.tool.result !== undefined) return { kind: 'thinking', since };
  return { kind: 'tool', tool: step.tool.tool, target: activityTarget(step.tool), since };
}

/** Live activity at the end of these transcript lines (exported for tests). */
export function activityFromLines(lines: string[]): ClaudeActivity | undefined {
  const tools = new Map<string, ClaudeChatMessage>();
  const conversation: ClaudeChatMessage[] = [];
  let step: TranscriptStep | undefined;
  for (const line of lines) {
    const messages = parseTranscriptLine(line);
    conversation.push(...messages);
    for (const message of messages) if (message.toolUseId) tools.set(message.toolUseId, message);
    const results = parseToolResults(line);
    for (const result of results) {
      const tool = tools.get(result.toolUseId);
      if (tool) tool.result = result.text;
    }
    step = nextStep(step, line, messages, results.length > 0, conversation);
  }
  return activityOf(step);
}

/** Read the Claude Code conversation running inside the process tree of `rootPid`. */
/**
 * Right after Claude turns busy the transcript may still end with the previous turn's last
 * step: don't time it from then ("Writing… · 2h 5m"); start from when Claude became busy.
 */
function currentTurn<T extends { since?: number }>(
  activity: T | undefined,
  busySince: number | undefined
): T | undefined {
  if (!activity || typeof busySince !== 'number') return activity;
  return activity.since !== undefined && activity.since < busySince
    ? { ...activity, since: busySince }
    : activity;
}

export async function readClaudeChat(
  rootPid: number,
  claudeDir = claudeConfigDir()
): Promise<ClaudeChat> {
  const { starts } = await processTable();
  for (const pid of await processTree(rootPid)) {
    const session = readSessionFile(claudeDir, pid, starts);
    if (!session?.sessionId || !session.cwd) continue;
    const transcriptPath = cachedFindTranscript(claudeDir, session.cwd, session.sessionId);
    const transcript = transcriptPath ? readTranscript(transcriptPath) : null;
    const background = waitingForBackground(session, transcript?.turnEnded);
    return {
      available: true,
      status: session.status,
      waitingFor: session.status === 'waiting' ? session.waitingFor : undefined,
      title: transcript?.title,
      activity:
        session.status === 'busy' && !background
          ? currentTurn(activityOf(transcript?.lastStep), session.statusUpdatedAt)
          : undefined,
      ...(background ? { waitingForBackground: true } : {}),
      messages: transcript?.messages ?? [],
    };
  }
  return { available: false, messages: [] };
}

export interface ClaudeStatus {
  status: string;
  waitingFor?: string;
  /** Claude Code conversation id (kept in session.json as claudeSessionId). */
  sessionId?: string;
  /** Conversation title Claude Code generated (ai-title). */
  title?: string;
  /** Last user or assistant message, one line, for session list previews. */
  preview?: { role: 'user' | 'assistant'; text: string };
  /** When the current status began (epoch ms): tells two identical prompts apart. */
  since?: number;
  /** While busy: what Claude is doing right now (from the transcript tail). */
  activity?: ClaudeActivity;
  /** Busy only because background agents or tasks run: the reply is over (see turnAfter). */
  waitingForBackground?: boolean;
}

const PREVIEW_MAX_LENGTH = 160;
const PREVIEW_TTL_MS = 2500;
const previewCache = new Map<
  string,
  {
    at: number;
    title?: string;
    preview?: ClaudeStatus['preview'];
    activity?: ClaudeActivity;
    turnEnded?: TurnEnd;
  }
>();

/**
 * A table's rows as their cells ("C · 1972"), its delimiter row dropped, rows joined by "; ".
 * Flattened to one line as markdown, a table read "| Language | Year | |---|---| | C | 1972 |"
 * in the session list and in pushes.
 */
function tablesAsText(markdown: string): string {
  const out: string[] = [];
  let rows: string[] = [];
  const flush = () => {
    if (rows.length > 0) out.push(rows.join('; '));
    rows = [];
  };
  for (const line of markdown.split('\n')) {
    const row = line.match(/^\s*\|(.*)\|\s*$/);
    if (!row) {
      flush();
      out.push(line);
    } else if (!/^[\s|:-]*$/.test(row[1])) {
      const cells = row[1].split('|').map((cell) => cell.trim());
      rows.push(cells.filter(Boolean).join(' · '));
    }
  }
  flush();
  return out.join('\n');
}

/** One line of plain text for a list preview: markdown markup removed, whitespace collapsed. */
export function plainPreview(markdown: string): string {
  return tablesAsText(markdown)
    .replace(/^\s*[-*•+]\s+/gm, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$|[.,;:!?])/g, '$1$2')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>)\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Title and last message of a transcript, re-read at most every couple of seconds. */
function transcriptSummary(transcriptPath: string) {
  const cached = previewCache.get(transcriptPath);
  if (cached && Date.now() - cached.at < PREVIEW_TTL_MS) return cached;
  let transcript: TranscriptCache;
  try {
    transcript = readTranscript(transcriptPath);
  } catch {
    return cached ?? { at: Date.now() };
  }
  let preview: ClaudeStatus['preview'];
  for (let i = transcript.messages.length - 1; i >= 0; i--) {
    const message = transcript.messages[i];
    if ((message.role === 'user' || message.role === 'assistant') && message.text.trim()) {
      const text = plainPreview(message.text);
      preview = {
        role: message.role,
        text: text.length > PREVIEW_MAX_LENGTH ? `${text.slice(0, PREVIEW_MAX_LENGTH - 1)}…` : text,
      };
      break;
    }
  }
  const summary = {
    at: Date.now(),
    title: transcript.title,
    preview,
    activity: activityOf(transcript.lastStep),
    turnEnded: transcript.turnEnded,
  };
  previewCache.set(transcriptPath, summary);
  if (previewCache.size > MAX_CACHED_TRANSCRIPTS) {
    previewCache.delete(previewCache.keys().next().value as string);
  }
  return summary;
}

/** Claude Code status for each session root pid that runs Claude Code. */
export async function readClaudeStatuses(
  rootPids: number[],
  claudeDir = claudeConfigDir()
): Promise<Map<number, ClaudeStatus>> {
  const statuses = new Map<number, ClaudeStatus>();
  const { starts } = await processTable();
  for (const rootPid of rootPids) {
    for (const pid of await processTree(rootPid)) {
      const session = readSessionFile(claudeDir, pid, starts);
      if (!session?.status) continue;
      const transcriptPath =
        session.sessionId && session.cwd
          ? cachedFindTranscript(claudeDir, session.cwd, session.sessionId)
          : null;
      const summary = transcriptPath ? transcriptSummary(transcriptPath) : undefined;
      const background = waitingForBackground(session, summary?.turnEnded);
      statuses.set(rootPid, {
        status: session.status,
        waitingFor: session.status === 'waiting' ? session.waitingFor : undefined,
        sessionId: session.sessionId,
        title: summary?.title,
        preview: summary?.preview,
        since: typeof session.statusUpdatedAt === 'number' ? session.statusUpdatedAt : undefined,
        activity:
          session.status === 'busy' && !background
            ? currentTurn(summary?.activity, session.statusUpdatedAt)
            : undefined,
        ...(background ? { waitingForBackground: true } : {}),
      });
      break;
    }
  }
  return statuses;
}
