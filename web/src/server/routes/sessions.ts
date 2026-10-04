import chalk from 'chalk';
import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import {
  looseText,
  type parseScreenChoices,
  sameMenuKey,
  takesReply,
} from '../../shared/claude-screen.js';
import { cellsToText } from '../../shared/terminal-text-formatter.js';
import type { ServerStatus, Session, TitleMode } from '../../shared/types.js';
import { HttpMethod } from '../../shared/types.js';
import { PtyError, type PtyManager } from '../pty/index.js';
import { claudeConversationExists, readClaudeStatuses } from '../services/claude-chat.js';
import {
  INITIAL_INPUT_MAX_LENGTH,
  type InitialInputAgent,
  type InitialInputOptions,
  typeWhenClaudeReady,
  typeWhenCodexReady,
} from '../services/claude-initial-input.js';
import { isCodexCommand, readCodexChat } from '../services/codex-chat.js';
import { codexSessionRef } from '../services/codex-process.js';
import { readGeminiChat } from '../services/gemini-chat.js';
import { geminiSessionRef } from '../services/gemini-process.js';
import type { LiveConversation } from '../services/mac-sessions/agents.js';
import { menuKeyHash } from '../services/menu-key-hash.js';
import type { RemoteRegistry } from '../services/remote-registry.js';
import { createScreenMenu } from '../services/screen-menu.js';
import { chatAnswer, readSessionChat } from '../services/session-chat.js';
import { createLastLineReader } from '../services/session-last-line.js';
import { tailscaleServeService } from '../services/tailscale-serve-service.js';
import { LARGE_REPLAY_MAX_BYTES, type TerminalManager } from '../services/terminal-manager.js';
import { detectGitInfo } from '../utils/git-info.js';
import { getDetailedGitStatus } from '../utils/git-status.js';
import { createLogger } from '../utils/logger.js';
import { resolveAbsolutePath } from '../utils/path-utils.js';
import { generateSessionName } from '../utils/session-naming.js';
import { createControlMessage, type TerminalSpawnResponse } from '../websocket/control-protocol.js';
import { controlUnixHandler } from '../websocket/control-unix-handler.js';

const logger = createLogger('sessions');
const _execFile = promisify(require('child_process').execFile);

interface SessionRoutesConfig {
  ptyManager: PtyManager;
  terminalManager: TerminalManager;
  remoteRegistry: RemoteRegistry | null;
  isHQMode: boolean;
  /**
   * Agent chat is on (config.json `agentChat` / VIBETUNNEL_AGENT_CHAT): asked on every
   * request, so the switch applies without a restart. Missing means off.
   */
  agentChatEnabled?: () => boolean;
  /**
   * Claude conversations running right now outside VibeTunnel (a terminal tab, a tmux pane):
   * `claude --resume` of one is refused, whoever asks. Asked only when a resume is requested.
   */
  liveClaudeConversations?: () => Promise<Map<string, LiveConversation>>;
}

/** A Claude Code conversation id, as `claude --resume` takes it (never a path or an option). */
const CLAUDE_CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The conversation `claude --resume <id>` (`-r <id>`, `--resume=<id>`) continues, if any. */
export function claudeResumeTarget(command: readonly unknown[]): string | null {
  if (typeof command[0] !== 'string' || path.basename(command[0]) !== 'claude') return null;
  for (let i = 1; i < command.length; i++) {
    const arg = command[i];
    if (typeof arg !== 'string') return null;
    if (arg.startsWith('--resume=')) return arg.slice('--resume='.length) || null;
    const next = command[i + 1];
    if ((arg === '--resume' || arg === '-r') && typeof next === 'string' && next) {
      return next.startsWith('-') ? null : next;
    }
  }
  return null;
}

// Helper function to resolve path with default fallback
function resolvePath(inputPath: string, defaultPath: string): string {
  if (!inputPath || inputPath.trim() === '') {
    return defaultPath;
  }

  // Use our utility function to handle tilde expansion and absolute path resolution
  const expanded = resolveAbsolutePath(inputPath);

  // If the input was relative (not starting with / or ~), resolve it relative to defaultPath
  if (!inputPath.startsWith('/') && !inputPath.startsWith('~')) {
    return path.join(defaultPath, inputPath);
  }

  return expanded;
}

/**
 * How long a reply waits for Claude to leave its menu (Esc) and show its prompt before the
 * text is typed. The phone keeps the message until then, so past this it says so instead.
 */
const REPLY_TYPE_WAIT_MS = 15_000;
/** Pause before each terminal warm-up of a long waiting session (see warmTerminal). */
const WARM_GAP_MS = 250;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The session's PTY is a tmux client attached to a tmux session that keeps running without it
 * (opened from "On this computer" or the tmux list): closing it detaches.
 */
function isAttachedToTmux(session: Pick<Session, 'multiplexer' | 'name' | 'command'>): boolean {
  return (
    !!session.multiplexer ||
    !!session.name?.startsWith('tmux:') ||
    !!session.command?.includes('tmux attach')
  );
}

export function createSessionRoutes(config: SessionRoutesConfig): Router {
  const router = Router();
  const { ptyManager, terminalManager, remoteRegistry, isHQMode } = config;

  // GET /sessions is polled every second or so by every client; a screen read is only needed
  // for sessions where Claude waits for an answer, and a couple of seconds of staleness is
  // fine. Concurrent polls share one read, and a session whose output would be costly to
  // replay is skipped (no quick answers for it; the session view still works).
  const choicesCache = new Map<string, { at: number; value: ScreenChoices }>();
  const choicesInFlight = new Map<string, Promise<ScreenChoices>>();
  type ScreenChoices = ReturnType<typeof parseScreenChoices>;

  // Read like the phone reads its copy (services/screen-menu.ts): the key of a menu read here
  // (the list's quick answers, the answer sheet, the check of an answer) and on the phone
  // covers the same lines, its dialog's top included where it scrolled out of sight.
  const screenMenu = createScreenMenu({
    recentText: (sessionId, lines) => terminalManager.getRecentText(sessionId, lines),
    sendInput: (sessionId, input) => ptyManager.sendInput(sessionId, input),
  });
  const readScreenChoices = (sessionId: string): Promise<ScreenChoices> =>
    screenMenu.read(sessionId);

  // A long session's screen reads cheaply only once its terminal exists, and nothing builds it
  // before someone opens the session: after a restart a long Claude session waiting for an
  // answer had no quick answers in the list. Built here, off the request, one at a time with a
  // pause between: each replay blocks the server (~0.3 s per 20 MB).
  const warming = new Set<string>();
  const warmQueue: string[] = [];
  let warmingNow = false;
  function warmTerminal(sessionId: string) {
    if (warming.has(sessionId)) return;
    if (!terminalManager.canSnapshotCheaply(sessionId, LARGE_REPLAY_MAX_BYTES)) return;
    warming.add(sessionId);
    warmQueue.push(sessionId);
    void drainWarmQueue();
  }
  async function drainWarmQueue() {
    if (warmingNow) return;
    warmingNow = true;
    try {
      for (let sessionId = warmQueue.shift(); sessionId; sessionId = warmQueue.shift()) {
        // Requests waiting meanwhile go first.
        await sleep(WARM_GAP_MS);
        await terminalManager
          .getBufferSnapshot(sessionId)
          .catch((error) => logger.debug(`could not build the terminal of ${sessionId}: ${error}`));
        warming.delete(sessionId);
      }
    } finally {
      warmingNow = false;
    }
  }

  async function screenChoices(sessionId: string): Promise<ScreenChoices> {
    const cached = choicesCache.get(sessionId);
    if (cached && Date.now() - cached.at < 2000) return cached.value;
    if (!terminalManager.canSnapshotCheaply(sessionId)) {
      warmTerminal(sessionId);
      return null;
    }
    let pending = choicesInFlight.get(sessionId);
    if (!pending) {
      pending = readScreenChoices(sessionId)
        .catch((error) => {
          logger.debug(`[GET /sessions] Could not read screen of ${sessionId}: ${error}`);
          return null;
        })
        .then((value) => {
          choicesCache.set(sessionId, { at: Date.now(), value });
          if (choicesCache.size > 100) {
            choicesCache.delete(choicesCache.keys().next().value as string);
          }
          return value;
        })
        .finally(() => choicesInFlight.delete(sessionId));
      choicesInFlight.set(sessionId, pending);
    }
    return pending;
  }

  // Last output line of shells and other non-Claude sessions, for the compact phone list (it
  // asks with ?lastLine=1). Same cost rules as above: only cheap screens, unchanged screens are
  // never re-read, and a changing one at most every 2 s.
  const lastLines = createLastLineReader({
    canSnapshotCheaply: (sessionId) => terminalManager.canSnapshotCheaply(sessionId),
    getChangeCount: (sessionId) => terminalManager.getChangeCount(sessionId),
    outputModifiedAt: (sessionId) => terminalManager.outputModifiedAt(sessionId),
    readScreenText: async (sessionId) =>
      cellsToText((await terminalManager.getBufferSnapshot(sessionId)).cells, false),
  });

  /**
   * Types `text` into the session once its agent is ready at its prompt, resolving to whether
   * it was typed: an "Ask Claude"/"Ask Codex" message waits for a new session's agent to start
   * (minutes, while the user answers its dialogs), a reply only for Claude to leave its menu.
   */
  function typeWhenReady(
    sessionId: string,
    text: string,
    options?: InitialInputOptions,
    agent: InitialInputAgent = 'claude'
  ): Promise<boolean> {
    const running = () => ptyManager.getSession(sessionId)?.status === 'running';
    const send = (input: { text: string } | { key: 'enter' }) => {
      if (running()) ptyManager.sendInput(sessionId, input);
    };
    const onGiveUp = (reason: string) =>
      logger.warn(`input for session ${sessionId} not typed: ${reason}`);
    if (agent === 'codex') {
      return typeWhenCodexReady(
        text,
        {
          isRunning: running,
          screenText: async () =>
            cellsToText((await terminalManager.getBufferSnapshot(sessionId)).cells, false),
          send,
          onGiveUp,
        },
        options
      );
    }
    return typeWhenClaudeReady(
      text,
      {
        isRunning: running,
        claudeStatus: async () => {
          const current = ptyManager.getSession(sessionId);
          const pid = current ? ptyManager.programRootPid(current) : undefined;
          return pid ? (await readClaudeStatuses([pid])).get(pid)?.status : undefined;
        },
        dialogOnScreen: async () => (await readScreenChoices(sessionId)) !== null,
        send,
        onGiveUp,
      },
      options
    );
  }

  /** Types an "Ask Claude"/"Ask Codex" message into a new session once the agent is ready. */
  function deliverInitialInput(sessionId: string, text: unknown, agent: InitialInputAgent) {
    if (typeof text !== 'string' || !text.trim()) return;
    typeWhenReady(sessionId, text, undefined, agent).catch((error) =>
      logger.error(`initial input for session ${sessionId} failed:`, error)
    );
  }

  // Server status endpoint
  router.get('/server/status', async (_req, res) => {
    logger.debug('[GET /server/status] Getting server status');

    let macAppConnected = false;
    try {
      macAppConnected = controlUnixHandler.isMacAppConnected();
    } catch (error) {
      // The Mac app connection is optional. Keep mode discovery available so a
      // transient control-socket failure cannot block normal web sessions.
      logger.warn('Failed to check Mac app connection; reporting disconnected:', error);
    }

    const status: ServerStatus = {
      macAppConnected,
      isHQMode,
      version: process.env.VERSION || 'unknown',
    };
    res.json(status);
  });

  // Tailscale Serve status endpoint
  router.get('/sessions/tailscale/status', async (_req, res) => {
    logger.debug('[GET /sessions/tailscale/status] Getting Tailscale Serve status');
    try {
      const status = await tailscaleServeService.getStatus();

      // Add helpful guidance for common issues
      if (!status.isRunning && status.isPermanentlyDisabled) {
        const enhancedStatus = {
          ...status,
          lastError: 'Tailscale Serve is disabled on your tailnet',
          recommendation:
            'VibeTunnel tried to enable Tailscale Serve but your tailnet requires admin approval. You can still use VibeTunnel normally - it will be accessible on your tailnet without the Serve proxy.',
          fallbackMode: "Running in standard mode - accessible via your machine's tailnet IP",
          permanentlyDisabled: true,
        };
        res.json(enhancedStatus);
      } else if (
        !status.isRunning &&
        status.lastError?.includes('Serve is not enabled on your tailnet')
      ) {
        const enhancedStatus = {
          ...status,
          lastError: 'Tailscale Serve feature requires tailnet permissions',
          recommendation:
            'Contact your Tailscale admin or visit your tailnet admin panel to enable the Serve feature',
          fallbackMode:
            'VibeTunnel is running in HTTP mode. You can still access it directly on your tailnet IP',
        };
        res.json(enhancedStatus);
      } else {
        res.json(status);
      }
    } catch (error) {
      logger.error('Failed to get Tailscale Serve status:', error);
      res.status(500).json({ error: 'Failed to get Tailscale Serve status' });
    }
  });

  // Tailscale connection test endpoint with diagnostics
  router.get('/sessions/tailscale/test', async (_req, res) => {
    logger.debug('[GET /sessions/tailscale/test] Testing Tailscale connection');
    try {
      const { spawn } = await import('child_process');
      const tailscaleExecutable = await tailscaleServeService.getExecutablePath().catch(() => null);

      // Test 1: Check if Tailscale is installed and running
      const tailscaleStatus = tailscaleExecutable
        ? await new Promise<{ isRunning: boolean; output: string }>((resolve) => {
            const statusProcess = spawn(tailscaleExecutable, ['status'], {
              stdio: ['ignore', 'pipe', 'pipe'],
            });

            let stdout = '';
            let stderr = '';

            if (statusProcess.stdout) {
              statusProcess.stdout.on('data', (data) => {
                stdout += data.toString();
              });
            }

            if (statusProcess.stderr) {
              statusProcess.stderr.on('data', (data) => {
                stderr += data.toString();
              });
            }

            statusProcess.on('exit', (code) => {
              const output = stdout || stderr;
              resolve({
                isRunning: code === 0,
                output: output.trim(),
              });
            });

            statusProcess.on('error', () => {
              resolve({
                isRunning: false,
                output: 'Tailscale command not found',
              });
            });

            setTimeout(() => {
              statusProcess.kill('SIGTERM');
              resolve({
                isRunning: false,
                output: 'Tailscale status check timeout',
              });
            }, 5000);
          })
        : {
            isRunning: false,
            output: 'Tailscale command not found',
          };

      // Test 2: Check Tailscale Serve configuration
      const serveStatus = await tailscaleServeService.getStatus();

      // Test 3: Check actual server binding
      const serverInfo = {
        isListening: true, // We're responding to this request
        port: process.env.PORT || '4020',
        bindAddress: process.env.BIND_ADDRESS || '127.0.0.1',
      };

      res.json({
        timestamp: new Date().toISOString(),
        tailscale: {
          installed: tailscaleStatus.isRunning,
          status: tailscaleStatus.output,
        },
        tailscaleServe: {
          configured: serveStatus.isRunning,
          port: serveStatus.port,
          error: serveStatus.lastError,
          startTime: serveStatus.startTime,
        },
        server: serverInfo,
        recommendations: generateTailscaleRecommendations(tailscaleStatus, {
          configured: serveStatus.isRunning,
          error: serveStatus.lastError,
        }),
      });
    } catch (error) {
      logger.error('Failed to test Tailscale connection:', error);
      res.status(500).json({
        error: 'Failed to perform Tailscale connection test',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /** Claude Code's status, title and preview on each running local session (agent chat). */
  async function addClaudeStatuses(sessions: Session[]): Promise<void> {
    try {
      // A session attached to a user's tmux session: its pid is the tmux client, so look under
      // the pane that client shows.
      const rootPid = (session: Session) =>
        session.status === 'running' ? ptyManager.programRootPid(session) : undefined;
      const runningPids = sessions
        .map(rootPid)
        .filter((pid): pid is number => typeof pid === 'number');
      const claudeStatuses = await readClaudeStatuses(runningPids);
      for (const session of sessions) {
        const pid = rootPid(session);
        const claudeStatus = pid ? claudeStatuses.get(pid) : undefined;
        if (!claudeStatus) continue;
        const { sessionId: claudeSessionId, ...status } = claudeStatus;
        session.claudeStatus = status;
        if (status.status === 'waiting') {
          // Quick answers from the list: the menu on screen, if any.
          const choices = await screenChoices(session.id);
          if (choices) session.claudeStatus.choices = choices;
        }
        if (status.title && session.claudeTitle !== status.title) {
          try {
            ptyManager.setClaudeTitle(session.id, status.title);
            session.claudeTitle = status.title;
          } catch (error) {
            logger.debug(`[GET /sessions] Could not save Claude title: ${error}`);
          }
        }
        if (claudeSessionId && session.claudeSessionId !== claudeSessionId) {
          // A failed save must not drop the statuses of the remaining sessions.
          try {
            ptyManager.setClaudeSessionId(session.id, claudeSessionId);
            session.claudeSessionId = claudeSessionId;
          } catch (error) {
            logger.debug(`[GET /sessions] Could not save Claude session id: ${error}`);
          }
        }
      }
    } catch (error) {
      logger.debug(`[GET /sessions] Could not read Claude statuses: ${error}`);
    }
  }

  /**
   * OpenAI Codex on each running local session where no Claude Code runs (agent chat): its
   * conversation title (the first prompt), like Claude's generated title.
   */
  async function addCodexTitles(sessions: Session[]): Promise<void> {
    for (const session of sessions) {
      if (session.status !== 'running' || session.claudeStatus) continue;
      try {
        const ref = await codexSessionRef({ ...session, pid: ptyManager.programRootPid(session) });
        if (!ref) continue;
        session.codexActive = true;
        const title = readCodexChat(ref).title;
        if (title) session.codexTitle = title;
      } catch (error) {
        logger.debug(`[GET /sessions] Could not read Codex title of ${session.id}: ${error}`);
      }
    }
  }

  /**
   * Gemini CLI on each running local session where neither Claude Code nor Codex runs (agent
   * chat): its first prompt as the title.
   */
  async function addGeminiTitles(sessions: Session[]): Promise<void> {
    for (const session of sessions) {
      if (session.status !== 'running' || session.claudeStatus || session.codexActive) continue;
      try {
        const ref = await geminiSessionRef({ ...session, pid: ptyManager.programRootPid(session) });
        if (!ref) continue;
        session.geminiActive = true;
        const title = readGeminiChat(ref).title;
        if (title) session.geminiTitle = title;
      } catch (error) {
        logger.debug(`[GET /sessions] Could not read Gemini title of ${session.id}: ${error}`);
      }
    }
  }

  // List all sessions (aggregate local + remote in HQ mode)
  router.get('/sessions', async (req, res) => {
    logger.debug('[GET /sessions] Listing all sessions');
    try {
      let allSessions = [];

      // Get local sessions
      const localSessions = ptyManager.listSessions();
      logger.debug(`[GET /sessions] Found ${localSessions.length} local sessions`);

      // Log session names for debugging
      // localSessions.forEach((session) => {
      //   logger.debug(
      //     `[GET /sessions] Session ${session.id}: name="${session.name || 'null'}", workingDir="${session.workingDir}"`
      //   );
      // });

      // Add source info to local sessions and detect Git info if missing
      const localSessionsWithSource = await Promise.all(
        localSessions.map(async (session) => {
          // If session doesn't have Git info, try to detect it
          if (!session.gitRepoPath && session.workingDir) {
            try {
              const gitInfo = await detectGitInfo(session.workingDir);
              // logger.debug(
              //   `[GET /sessions] Detected Git info for session ${session.id}: repo=${gitInfo.gitRepoPath}, branch=${gitInfo.gitBranch}`
              // );
              return {
                ...session,
                ...gitInfo,
                source: 'local' as const,
              };
            } catch (error) {
              // If Git detection fails, just return session as-is
              logger.debug(
                `[GET /sessions] Could not detect Git info for session ${session.id}: ${error}`
              );
            }
          }

          return {
            ...session,
            source: 'local' as const,
          };
        })
      );

      // Agent chat on: Claude Code's status per session (working / waiting for the user / idle),
      // its conversation title and last message, and on a waiting session the menu on screen.
      // Off, no process tree, transcript or screen is read for this.
      if (config.agentChatEnabled?.()) {
        await addClaudeStatuses(localSessionsWithSource as Session[]);
        await addCodexTitles(localSessionsWithSource as Session[]);
        await addGeminiTitles(localSessionsWithSource as Session[]);
        // Exited Claude sessions: offer "resume" only when there is a conversation to resume.
        for (const session of localSessionsWithSource as Session[]) {
          if (session.status !== 'exited' || !session.claudeSessionId || !session.workingDir) {
            continue;
          }
          // Attached to tmux, the conversation still runs there: resuming it would make a
          // second writer of it.
          if (isAttachedToTmux(session)) {
            session.claudeResumable = false;
            continue;
          }
          try {
            session.claudeResumable = claudeConversationExists(
              session.workingDir,
              session.claudeSessionId
            );
          } catch {
            session.claudeResumable = false;
          }
        }
      }
      // The compact phone list shows a shell's last line of output instead of a preview.
      if (req.query?.lastLine === '1') {
        await Promise.all(
          (localSessionsWithSource as Session[]).map(async (session) => {
            if (session.status !== 'running' || session.claudeStatus) return;
            try {
              const lastLine = await lastLines.get(session.id);
              if (lastLine) session.lastLine = lastLine;
            } catch (error) {
              logger.debug(`[GET /sessions] Could not read last line of ${session.id}: ${error}`);
            }
          })
        );
      }

      allSessions = [...localSessionsWithSource];

      // If in HQ mode, aggregate sessions from all remotes
      if (isHQMode && remoteRegistry) {
        const remotes = remoteRegistry.getRemotes();
        logger.debug(`checking ${remotes.length} remote servers for sessions`);

        // Fetch sessions from each remote in parallel
        const remotePromises = remotes.map(async (remote) => {
          try {
            const response = await fetch(`${remote.url}/api/sessions`, {
              headers: {
                Authorization: `Bearer ${remote.token}`,
              },
              signal: AbortSignal.timeout(5000), // 5 second timeout
            });

            if (response.ok) {
              const remoteSessions = (await response.json()) as Session[];
              logger.debug(`got ${remoteSessions.length} sessions from remote ${remote.name}`);

              // Track session IDs for this remote
              const sessionIds = remoteSessions.map((s: Session) => s.id);
              remoteRegistry.updateRemoteSessions(remote.id, sessionIds);

              // Add remote info to each session
              return remoteSessions.map((session: Session) => ({
                ...session,
                source: 'remote',
                remoteId: remote.id,
                remoteName: remote.name,
                remoteUrl: remote.url,
              }));
            } else {
              logger.warn(
                `failed to get sessions from remote ${remote.name}: HTTP ${response.status}`
              );
              return [];
            }
          } catch (error) {
            logger.error(`failed to get sessions from remote ${remote.name}:`, error);
            return [];
          }
        });

        const remoteResults = await Promise.all(remotePromises);
        const remoteSessions = remoteResults.flat();
        logger.debug(`total remote sessions: ${remoteSessions.length}`);

        allSessions = [...allSessions, ...remoteSessions];
      }

      logger.debug(`returning ${allSessions.length} total sessions`);
      res.json(allSessions);
    } catch (error) {
      logger.error('error listing sessions:', error);
      res.status(500).json({ error: 'Failed to list sessions' });
    }
  });

  // Create new session (local or on remote)
  router.post('/sessions', async (req, res) => {
    const { command, workingDir, name, remoteId, spawn_terminal, cols, rows, titleMode } = req.body;
    // "Ask Claude"/"Ask Codex": a first message the server types into the new session once its
    // agent is ready (agent chat only: readiness comes from the agent's status and screen).
    const { initialInput, initialInputAgent } = req.body;
    logger.debug(
      `creating new session: command=${JSON.stringify(command)}, remoteId=${remoteId || 'local'}, spawn_terminal=${spawn_terminal}, cols=${cols}, rows=${rows}`
    );

    if (!command || !Array.isArray(command) || command.length === 0) {
      logger.warn('session creation failed: invalid command array');
      return res.status(400).json({ error: 'Command array is required' });
    }

    if (
      initialInput !== undefined &&
      (typeof initialInput !== 'string' || initialInput.length > INITIAL_INPUT_MAX_LENGTH)
    ) {
      return res.status(400).json({ error: 'initialInput must be a string' });
    }
    if (
      initialInputAgent !== undefined &&
      initialInputAgent !== 'claude' &&
      initialInputAgent !== 'codex'
    ) {
      return res.status(400).json({ error: 'initialInputAgent must be "claude" or "codex"' });
    }
    if (initialInput !== undefined && !config.agentChatEnabled?.()) {
      return res
        .status(403)
        .json({ error: 'initialInput needs agent chat', code: 'agent-chat-off' });
    }
    // Which agent's prompt to wait for: as asked, else what the command runs.
    const inputAgent: InitialInputAgent =
      initialInputAgent ?? (isCodexCommand(command) ? 'codex' : 'claude');

    try {
      // If remoteId is specified and we're in HQ mode, forward to remote
      if (remoteId && isHQMode && remoteRegistry) {
        const remote = remoteRegistry.getRemote(remoteId);
        if (!remote) {
          logger.warn(`session creation failed: remote ${remoteId} not found`);
          return res.status(404).json({ error: 'Remote server not found' });
        }

        logger.log(chalk.blue(`forwarding session creation to remote ${remote.name}`));

        // Forward the request to the remote server
        const startTime = Date.now();
        const response = await fetch(`${remote.url}/api/sessions`, {
          method: HttpMethod.POST,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${remote.token}`,
          },
          body: JSON.stringify({
            command,
            workingDir,
            name,
            spawn_terminal,
            cols,
            rows,
            titleMode,
            initialInput,
            initialInputAgent,
            // Don't forward remoteId to avoid recursion
          }),
          signal: AbortSignal.timeout(10000), // 10 second timeout
        });

        if (!response.ok) {
          const error = await response.json().catch(() => ({ error: 'Unknown error' }));
          return res.status(response.status).json(error);
        }

        const result = (await response.json()) as { sessionId: string; createdAt?: string };
        logger.debug(`remote session creation took ${Date.now() - startTime}ms`);

        // Track the session in the remote's sessionIds
        if (result.sessionId) {
          remoteRegistry.addSessionToRemote(remote.id, result.sessionId);
        }

        // Forward the complete response (maintains compatibility with newer/older servers)
        res.json(result);
        return;
      }

      // HQ never spawns locally: a session must land on a registered remote. This
      // covers BOTH local-spawn paths below (terminal spawn + web session) but not
      // the forward-to-remote branch above (which already returned). On a Mac
      // remote isHQMode is false, so the forwarded request still spawns normally.
      if (isHQMode && !remoteId) {
        const count = remoteRegistry?.getRemotes().length ?? 0;
        logger.warn('session creation refused: HQ mode requires a target remote');
        return res.status(400).json({
          error:
            count === 0
              ? 'No machines are registered with this HQ, so no session can be created. Start VibeTunnel on a machine first.'
              : 'A target machine (remoteId) is required in HQ mode.',
        });
      }

      // A conversation running outside VibeTunnel right now (a terminal tab, a tmux pane) is
      // never resumed here, whoever asks: that would make a second writer of it.
      const resumed = claudeResumeTarget(command);
      const liveElsewhere =
        resumed && CLAUDE_CONVERSATION_ID.test(resumed)
          ? (await config.liveClaudeConversations?.().catch(() => undefined))?.get(resumed)
          : undefined;
      if (liveElsewhere) {
        return res.status(409).json({
          error: 'live-elsewhere',
          details: 'This conversation is running outside VibeTunnel right now',
          live: liveElsewhere,
        });
      }

      // If spawn_terminal is true, use the control socket for terminal spawning
      if (spawn_terminal) {
        try {
          // Generate session ID
          const sessionId = generateSessionId();
          const resolvedCwd = resolvePath(workingDir, process.cwd());
          const sessionName = name || generateSessionName(command, resolvedCwd);

          // Detect Git information for terminal spawn
          const gitInfo = await detectGitInfo(resolvedCwd);

          // Request Mac app to spawn terminal
          logger.log(
            chalk.blue(`requesting terminal spawn with command: ${JSON.stringify(command)}`)
          );
          const spawnResult = await requestTerminalSpawn({
            sessionId,
            sessionName,
            command,
            workingDir: resolvedCwd,
            titleMode,
            gitRepoPath: gitInfo.gitRepoPath,
            gitBranch: gitInfo.gitBranch,
            gitAheadCount: gitInfo.gitAheadCount,
            gitBehindCount: gitInfo.gitBehindCount,
            gitHasChanges: gitInfo.gitHasChanges,
            gitIsWorktree: gitInfo.gitIsWorktree,
            gitMainRepoPath: gitInfo.gitMainRepoPath,
          });

          if (!spawnResult.success) {
            // Log the error but continue with fallback
            logger.warn('terminal spawn failed:', spawnResult.error || 'Unknown error');
            logger.debug('falling back to normal web session');
          } else {
            // Wait a bit for the session to be created
            await new Promise((resolve) => setTimeout(resolve, 500));

            // Return the session ID - client will poll for the session to appear
            logger.log(chalk.green(`terminal spawn requested for session ${sessionId}`));
            deliverInitialInput(sessionId, initialInput, inputAgent);
            res.json({
              sessionId,
              createdAt: new Date().toISOString(),
              message: 'Terminal spawn requested',
            });
            return;
          }
        } catch (error) {
          // Log the error but continue with fallback
          logger.error('error spawning terminal:', error);
          logger.debug('falling back to normal web session');
        }
      }

      // Create local session
      let cwd = resolvePath(workingDir, process.cwd());

      // Check if the working directory exists, fall back to process.cwd() if not
      if (!fs.existsSync(cwd)) {
        logger.warn(
          `Working directory '${cwd}' does not exist, using current directory as fallback`
        );
        cwd = process.cwd();
      }

      const sessionName = name || generateSessionName(command, cwd);

      // Detect Git information
      const gitInfo = await detectGitInfo(cwd);

      logger.log(
        chalk.blue(
          `creating WEB session: ${command.join(' ')} in ${cwd} (spawn_terminal=${spawn_terminal})`
        )
      );

      const result = await ptyManager.createSession(command, {
        name: sessionName,
        workingDir: cwd,
        cols,
        rows,
        titleMode,
        gitRepoPath: gitInfo.gitRepoPath,
        gitBranch: gitInfo.gitBranch,
        gitAheadCount: gitInfo.gitAheadCount,
        gitBehindCount: gitInfo.gitBehindCount,
        gitHasChanges: gitInfo.gitHasChanges,
        gitIsWorktree: gitInfo.gitIsWorktree,
        gitMainRepoPath: gitInfo.gitMainRepoPath,
      });

      const { sessionId, sessionInfo } = result;
      logger.log(chalk.green(`WEB session ${sessionId} created (PID: ${sessionInfo.pid})`));

      // Stream watcher is set up when clients connect to the stream endpoint
      deliverInitialInput(sessionId, initialInput, inputAgent);

      res.json({ sessionId, createdAt: new Date().toISOString() });
    } catch (error) {
      logger.error('error creating session:', error);
      if (error instanceof PtyError) {
        res.status(500).json({ error: 'Failed to create session', details: error.message });
      } else {
        res.status(500).json({ error: 'Failed to create session' });
      }
    }
  });

  // Get git status for a specific session
  router.get('/sessions/:sessionId/git-status', async (req, res) => {
    const sessionId = req.params.sessionId;

    try {
      // If in HQ mode, check if this is a remote session
      if (isHQMode && remoteRegistry) {
        const remote = remoteRegistry.getRemoteBySessionId(sessionId);
        if (remote) {
          // Forward to remote server
          try {
            const response = await fetch(`${remote.url}/api/sessions/${sessionId}/git-status`, {
              headers: {
                Authorization: `Bearer ${remote.token}`,
              },
              signal: AbortSignal.timeout(5000),
            });

            if (!response.ok) {
              return res.status(response.status).json(await response.json());
            }

            return res.json(await response.json());
          } catch (error) {
            logger.error(`failed to get git status from remote ${remote.name}:`, error);
            return res.status(503).json({ error: 'Failed to reach remote server' });
          }
        }
      }

      // Local session handling
      const session = ptyManager.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Get detailed git status for the session's working directory
      const gitStatus = await getDetailedGitStatus(session.workingDir);

      res.json(gitStatus);
    } catch (error) {
      logger.error(`error getting git status for session ${sessionId}:`, error);
      res.status(500).json({ error: 'Failed to get git status' });
    }
  });

  // Get single session info
  router.get('/sessions/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    logger.debug(`getting info for session ${sessionId}`);

    try {
      // If in HQ mode, check if this is a remote session
      if (isHQMode && remoteRegistry) {
        const remote = remoteRegistry.getRemoteBySessionId(sessionId);
        if (remote) {
          // Forward to remote server
          try {
            const response = await fetch(`${remote.url}/api/sessions/${sessionId}`, {
              headers: {
                Authorization: `Bearer ${remote.token}`,
              },
              signal: AbortSignal.timeout(5000),
            });

            if (!response.ok) {
              return res.status(response.status).json(await response.json());
            }

            return res.json(await response.json());
          } catch (error) {
            logger.error(`failed to get session info from remote ${remote.name}:`, error);
            return res.status(503).json({ error: 'Failed to reach remote server' });
          }
        }
      }

      // Local session handling
      const session = ptyManager.getSession(sessionId);

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // If session doesn't have Git info, try to detect it
      if (!session.gitRepoPath && session.workingDir) {
        try {
          const gitInfo = await detectGitInfo(session.workingDir);
          // logger.debug(
          //   `[GET /sessions/:id] Detected Git info for session ${session.id}: repo=${gitInfo.gitRepoPath}, branch=${gitInfo.gitBranch}`
          // );
          res.json({ ...session, ...gitInfo });
          return;
        } catch (error) {
          // If Git detection fails, just return session as-is
          logger.debug(
            `[GET /sessions/:id] Could not detect Git info for session ${session.id}: ${error}`
          );
        }
      }

      res.json(session);
    } catch (error) {
      logger.error('error getting session info:', error);
      res.status(500).json({ error: 'Failed to get session info' });
    }
  });

  // Kill session (just kill the process)
  router.delete('/sessions/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    logger.debug(`killing session ${sessionId}`);

    try {
      // If in HQ mode, check if this is a remote session
      if (isHQMode && remoteRegistry) {
        const remote = remoteRegistry.getRemoteBySessionId(sessionId);
        if (remote) {
          // Forward kill request to remote server
          try {
            const response = await fetch(`${remote.url}/api/sessions/${sessionId}`, {
              method: HttpMethod.DELETE,
              headers: {
                Authorization: `Bearer ${remote.token}`,
              },
              signal: AbortSignal.timeout(10000),
            });

            if (!response.ok) {
              return res.status(response.status).json(await response.json());
            }

            // Remote killed the session, now update our registry
            remoteRegistry.removeSessionFromRemote(sessionId);
            logger.log(chalk.yellow(`remote session ${sessionId} killed on ${remote.name}`));

            return res.json(await response.json());
          } catch (error) {
            logger.error(`failed to kill session on remote ${remote.name}:`, error);
            return res.status(503).json({ error: 'Failed to reach remote server' });
          }
        }
      }

      // Local session handling - just kill it, no registry updates needed
      const session = ptyManager.getSession(sessionId);

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // If session is already exited, clean it up instead of trying to kill it
      if (session.status === 'exited') {
        ptyManager.cleanupSession(sessionId);
        logger.log(chalk.yellow(`local session ${sessionId} cleaned up`));
        res.json({ success: true, message: 'Session cleaned up' });
      } else {
        // A tmux attachment is detached, and its tmux session keeps running.
        const isTmuxAttachment = isAttachedToTmux(session);

        await ptyManager.killSession(sessionId, 'SIGTERM');

        if (isTmuxAttachment) {
          logger.log(chalk.yellow(`local session ${sessionId} detached from tmux`));
          res.json({ success: true, message: 'Detached from tmux session' });
        } else {
          logger.log(chalk.yellow(`local session ${sessionId} killed`));
          res.json({ success: true, message: 'Session killed' });
        }
      }
    } catch (error) {
      logger.error('error killing session:', error);
      if (error instanceof PtyError) {
        res.status(500).json({ error: 'Failed to kill session', details: error.message });
      } else {
        res.status(500).json({ error: 'Failed to kill session' });
      }
    }
  });

  // Cleanup session files
  router.delete('/sessions/:sessionId/cleanup', async (req, res) => {
    const sessionId = req.params.sessionId;
    logger.debug(`cleaning up session ${sessionId} files`);

    try {
      // If in HQ mode, check if this is a remote session
      if (isHQMode && remoteRegistry) {
        const remote = remoteRegistry.getRemoteBySessionId(sessionId);
        if (remote) {
          // Forward cleanup request to remote server
          try {
            const response = await fetch(`${remote.url}/api/sessions/${sessionId}/cleanup`, {
              method: HttpMethod.DELETE,
              headers: {
                Authorization: `Bearer ${remote.token}`,
              },
              signal: AbortSignal.timeout(10000),
            });

            if (!response.ok) {
              return res.status(response.status).json(await response.json());
            }

            // Remote cleaned up the session, now update our registry
            remoteRegistry.removeSessionFromRemote(sessionId);
            logger.log(chalk.yellow(`remote session ${sessionId} cleaned up on ${remote.name}`));

            return res.json(await response.json());
          } catch (error) {
            logger.error(`failed to cleanup session on remote ${remote.name}:`, error);
            return res.status(503).json({ error: 'Failed to reach remote server' });
          }
        }
      }

      // Local session handling - just cleanup, no registry updates needed
      ptyManager.cleanupSession(sessionId);
      logger.log(chalk.yellow(`local session ${sessionId} cleaned up`));

      res.json({ success: true, message: 'Session cleaned up' });
    } catch (error) {
      logger.error('error cleaning up session:', error);
      if (error instanceof PtyError) {
        res.status(500).json({ error: 'Failed to cleanup session', details: error.message });
      } else {
        res.status(500).json({ error: 'Failed to cleanup session' });
      }
    }
  });

  // Cleanup all exited sessions (local and remote)
  router.post('/cleanup-exited', async (_req, res) => {
    logger.log(chalk.blue('cleaning up all exited sessions'));
    try {
      // Clean up local sessions
      const localCleanedSessions = ptyManager.cleanupExitedSessions();
      logger.log(chalk.green(`cleaned up ${localCleanedSessions.length} local exited sessions`));

      // Remove cleaned local sessions from remote registry if in HQ mode
      if (isHQMode && remoteRegistry) {
        for (const sessionId of localCleanedSessions) {
          remoteRegistry.removeSessionFromRemote(sessionId);
        }
      }

      let totalCleaned = localCleanedSessions.length;
      const remoteResults: Array<{ remoteName: string; cleaned: number; error?: string }> = [];

      // If in HQ mode, clean up sessions on all remotes
      if (isHQMode && remoteRegistry) {
        const allRemotes = remoteRegistry.getRemotes();

        // Clean up on each remote in parallel
        const remoteCleanupPromises = allRemotes.map(async (remote) => {
          try {
            const response = await fetch(`${remote.url}/api/cleanup-exited`, {
              method: HttpMethod.POST,
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${remote.token}`,
              },
              signal: AbortSignal.timeout(10000), // 10 second timeout
            });

            if (response.ok) {
              const result = (await response.json()) as { cleanedSessions: string[] };
              const cleanedSessionIds = result.cleanedSessions || [];
              const cleanedCount = cleanedSessionIds.length;
              totalCleaned += cleanedCount;

              // Remove cleaned remote sessions from registry
              for (const sessionId of cleanedSessionIds) {
                remoteRegistry.removeSessionFromRemote(sessionId);
              }

              remoteResults.push({ remoteName: remote.name, cleaned: cleanedCount });
            } else {
              throw new Error(`HTTP ${response.status}`);
            }
          } catch (error) {
            logger.error(`failed to cleanup sessions on remote ${remote.name}:`, error);
            remoteResults.push({
              remoteName: remote.name,
              cleaned: 0,
              error: error instanceof Error ? error.message : 'Unknown error',
            });
          }
        });

        await Promise.all(remoteCleanupPromises);
      }

      res.json({
        success: true,
        message: `${totalCleaned} exited sessions cleaned up across all servers`,
        localCleaned: localCleanedSessions.length,
        remoteResults,
      });
    } catch (error) {
      logger.error('error cleaning up exited sessions:', error);
      if (error instanceof PtyError) {
        res
          .status(500)
          .json({ error: 'Failed to cleanup exited sessions', details: error.message });
      } else {
        res.status(500).json({ error: 'Failed to cleanup exited sessions' });
      }
    }
  });

  // Get session plain text
  router.get('/sessions/:sessionId/text', async (req, res) => {
    const sessionId = req.params.sessionId;
    const includeStyles = req.query.styles !== undefined;
    logger.debug(`getting plain text for session ${sessionId}, styles=${includeStyles}`);

    try {
      // If in HQ mode, check if this is a remote session
      if (isHQMode && remoteRegistry) {
        const remote = remoteRegistry.getRemoteBySessionId(sessionId);
        if (remote) {
          // Forward text request to remote server
          try {
            const url = new URL(`${remote.url}/api/sessions/${sessionId}/text`);
            if (includeStyles) {
              url.searchParams.set('styles', '');
            }

            const response = await fetch(url.toString(), {
              headers: {
                Authorization: `Bearer ${remote.token}`,
              },
              signal: AbortSignal.timeout(5000),
            });

            if (!response.ok) {
              return res.status(response.status).json(await response.json());
            }

            // Forward the text response
            const text = await response.text();
            res.setHeader('Content-Type', 'text/plain');
            return res.send(text);
          } catch (error) {
            logger.error(`failed to get text from remote ${remote.name}:`, error);
            return res.status(503).json({ error: 'Failed to reach remote server' });
          }
        }
      }

      // Local session handling
      const session = ptyManager.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Get terminal buffer snapshot
      const snapshot = await terminalManager.getBufferSnapshot(sessionId);

      // Use shared formatter to convert cells to text
      const plainText = cellsToText(snapshot.cells, includeStyles);

      // Send as plain text
      res.setHeader('Content-Type', 'text/plain');
      res.send(plainText);
    } catch (error) {
      logger.error('error getting plain text:', error);
      res.status(500).json({ error: 'Failed to get terminal text' });
    }
  });

  // The agent conversation running in a local session (phone chat mode). Refused unless agent
  // chat is on: nothing reads an agent's process tree or transcripts while it is off.
  router.get('/sessions/:sessionId/claude-chat', async (req, res) => {
    if (!config.agentChatEnabled?.()) {
      return res.status(403).json({ error: 'Agent chat is disabled', code: 'disabled' });
    }
    const session = ptyManager.getSession(req.params.sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!session.pid || session.status !== 'running') {
      return res.json({ available: false, messages: [] });
    }
    try {
      // Attached to a user's tmux session: the program in the pane its client shows.
      const programPid = ptyManager.programRootPid(session) ?? session.pid;
      const chat = await readSessionChat({ ...session, pid: session.pid }, programPid);
      // `?have=<fingerprint>`: the client already shows these messages; leave them out.
      res.json(chatAnswer(chat, req.query?.have));
    } catch (error) {
      logger.error('error reading agent chat:', error);
      res.status(500).json({ error: 'Failed to read the conversation' });
    }
  });

  // Send input to session
  router.post('/sessions/:sessionId/input', async (req, res) => {
    const sessionId = req.params.sessionId;
    const { text, key } = req.body;

    // Validate that only one of text or key is provided
    if ((text === undefined && key === undefined) || (text !== undefined && key !== undefined)) {
      logger.warn(
        `invalid input request for session ${sessionId}: both or neither text/key provided`
      );
      return res.status(400).json({ error: 'Either text or key must be provided, but not both' });
    }

    if (text !== undefined && typeof text !== 'string') {
      logger.warn(`invalid input request for session ${sessionId}: text is not a string`);
      return res.status(400).json({ error: 'Text must be a string' });
    }

    if (key !== undefined && typeof key !== 'string') {
      logger.warn(`invalid input request for session ${sessionId}: key is not a string`);
      return res.status(400).json({ error: 'Key must be a string' });
    }

    try {
      // If in HQ mode, check if this is a remote session
      if (isHQMode && remoteRegistry) {
        const remote = remoteRegistry.getRemoteBySessionId(sessionId);
        if (remote) {
          // Forward input to remote server
          try {
            const response = await fetch(`${remote.url}/api/sessions/${sessionId}/input`, {
              method: HttpMethod.POST,
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${remote.token}`,
              },
              body: JSON.stringify(req.body),
              signal: AbortSignal.timeout(5000),
            });

            if (!response.ok) {
              return res.status(response.status).json(await response.json());
            }

            return res.json(await response.json());
          } catch (error) {
            logger.error(`failed to send input to remote ${remote.name}:`, error);
            return res.status(503).json({ error: 'Failed to reach remote server' });
          }
        }
      }

      // Local session handling
      const session = ptyManager.getSession(sessionId);
      if (!session) {
        logger.error(`session ${sessionId} not found for input`);
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.status !== 'running') {
        logger.error(`session ${sessionId} is not running (status: ${session.status})`);
        return res.status(400).json({ error: 'Session is not running' });
      }

      const inputData = text !== undefined ? { text } : { key };
      logger.debug(`sending input to session ${sessionId}: ${JSON.stringify(inputData)}`);

      ptyManager.sendInput(sessionId, inputData);
      res.json({ success: true });
    } catch (error) {
      logger.error('error sending input:', error);
      if (error instanceof PtyError) {
        res.status(500).json({ error: 'Failed to send input', details: error.message });
      } else {
        res.status(500).json({ error: 'Failed to send input' });
      }
    }
  });

  // One answer at a time per session: two taps (or the phone and a push) must not both press
  // keys into the same menu.
  const answering = new Set<string>();

  /**
   * The menu the client showed is the one on screen: same question (one there is), or same
   * options, compared loosely; and the same key (its lines up to the dialog's top).
   * Consecutive permission prompts share question and options: without the key, a late tap
   * approved the next command. A client that sends no key for a menu that has one (an answer
   * sheet still on a push's choices sends the push's keyHash instead) is not trusted with it;
   * a yes/no question has none. Nothing of the screen is logged: only lengths.
   */
  function sameMenu(
    sessionId: string,
    choices: NonNullable<ScreenChoices>,
    body: { question?: unknown; options?: unknown; key?: unknown; keyHash?: unknown }
  ): boolean {
    const question = looseText(choices.question);
    const sameQuestion =
      question !== '' && typeof body.question === 'string' && looseText(body.question) === question;
    const sameOptions =
      choices.navigate === true &&
      Array.isArray(body.options) &&
      body.options.every((option) => typeof option === 'string') &&
      looseText(body.options.join('')) === looseText(choices.options.join(''));
    if (!sameQuestion && !sameOptions) return false;
    if (!choices.key) return true;
    if (typeof body.key !== 'string' || !body.key) {
      if (typeof body.keyHash === 'string' && body.keyHash === menuKeyHash(choices.key)) {
        return true;
      }
      logger.log(`menu key of ${sessionId}: the client sent none`);
      return false;
    }
    if (sameMenuKey(body.key, choices.key)) return true;
    logger.log(
      `menu key of ${sessionId} differs (client ${body.key.length} chars, server ${choices.key.length})`
    );
    return false;
  }

  // Answer a menu on screen (phone list quick answers, the chat's question card, the answer
  // sheet). The client sends the question and options it showed; the screen is re-read and the
  // answer only given if that menu is still the one waiting, so a stale button can't approve a
  // newer prompt. Only a user's tap calls this: nothing answers by itself.
  router.post('/sessions/:sessionId/answer', async (req, res) => {
    if (!config.agentChatEnabled?.()) {
      return res.status(403).json({ error: 'Agent chat is disabled', code: 'disabled' });
    }
    const { sessionId } = req.params;
    const { option, question } = req.body ?? {};
    if (!Number.isInteger(option) || option < 1 || option > 9 || typeof question !== 'string') {
      return res.status(400).json({ error: 'option (1-9) and question are required' });
    }
    const session = ptyManager.getSession(sessionId);
    if (session?.status !== 'running') {
      return res.status(404).json({ error: 'Session not found or not running' });
    }
    // A tmux client attached read-only: tmux drops the keys, and the answer would never land.
    if (session.multiplexer?.mode === 'watch') return res.status(409).json({ error: 'read-only' });
    if (answering.has(sessionId)) return res.status(409).json({ error: 'busy' });
    answering.add(sessionId);
    try {
      const choices = await readScreenChoices(sessionId);
      if (!choices || !sameMenu(sessionId, choices, req.body) || option > choices.options.length) {
        logger.log(`answer to ${sessionId}: the prompt changed (option ${option})`);
        return res.status(409).json({ error: 'The prompt changed' });
      }
      logger.log(`answer to ${sessionId}: option ${option} of ${choices.options.length}`);
      choicesCache.delete(sessionId);
      if (choices.navigate) {
        // The cursor to the option, verified on screen before any Enter (screen-menu.ts).
        if (!(await screenMenu.moveCursor(sessionId, choices, option - 1))) {
          return res.status(409).json({ error: 'The prompt changed' });
        }
        ptyManager.sendInput(sessionId, { key: 'enter' });
        return res.json({ success: true });
      }
      if (!choices.keys) return res.status(409).json({ error: 'The prompt changed' });
      // A "(y/n)" question reads a line: the letter, then Enter (the letter alone left a
      // shell's "Continue? [Y/n]" waiting).
      ptyManager.sendInput(sessionId, { text: choices.keys[option - 1] });
      ptyManager.sendInput(sessionId, { key: 'enter' });
      res.json({ success: true });
    } catch (error) {
      logger.error('error answering prompt:', error);
      res.status(500).json({ error: 'Failed to answer' });
    } finally {
      answering.delete(sessionId);
    }
  });

  /** Claude Code's status for a running session, read live (not the list's cached one). */
  async function liveClaudeStatus(sessionId: string) {
    const session = ptyManager.getSession(sessionId);
    const pid = session ? ptyManager.programRootPid(session) : undefined;
    return pid ? (await readClaudeStatuses([pid])).get(pid) : undefined;
  }

  // The answer sheet asks what is waiting right now before it shows its buttons: what it was
  // opened from may be minutes old.
  router.get('/sessions/:sessionId/prompt', async (req, res) => {
    if (!config.agentChatEnabled?.()) {
      return res.status(403).json({ error: 'Agent chat is disabled', code: 'disabled' });
    }
    const { sessionId } = req.params;
    if (ptyManager.getSession(sessionId)?.status !== 'running') {
      return res.status(404).json({ error: 'Session not found or not running' });
    }
    try {
      const claude = await liveClaudeStatus(sessionId);
      const waiting = claude?.status === 'waiting';
      const choices = waiting ? await readScreenChoices(sessionId) : null;
      res.json({
        waiting,
        waitingFor: waiting ? claude?.waitingFor : undefined,
        choices: choices
          ? {
              question: choices.question,
              options: choices.options,
              detail: choices.detail,
              key: choices.key,
            }
          : null,
      });
    } catch (error) {
      logger.error('error reading prompt:', error);
      res.status(500).json({ error: 'Failed to read prompt' });
    }
  });

  // A written answer to Claude waiting on a menu (the answer sheet, the phone composer). Like
  // /answer, the client sends the menu it showed (null when it saw none) and nothing is typed if
  // the screen moved on. Esc dismisses the menu first (Claude's own "No, and tell Claude what to
  // do differently"), then the text is typed once Claude is back at its prompt; the response
  // waits for that, so the phone keeps the message until it is really typed.
  router.post('/sessions/:sessionId/reply', async (req, res) => {
    if (!config.agentChatEnabled?.()) {
      return res.status(403).json({ error: 'Agent chat is disabled', code: 'disabled' });
    }
    const { sessionId } = req.params;
    const { text, question, options } = req.body ?? {};
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required' });
    }
    if (question !== null && typeof question !== 'string') {
      return res.status(400).json({ error: 'question must be a string or null' });
    }
    if (text.length > INITIAL_INPUT_MAX_LENGTH) {
      return res.status(413).json({ error: 'text is too long' });
    }
    const session = ptyManager.getSession(sessionId);
    if (session?.status !== 'running') {
      return res.status(404).json({ error: 'Session not found or not running' });
    }
    // A tmux client attached read-only: tmux drops the keys, and the answer would never land.
    if (session.multiplexer?.mode === 'watch') return res.status(409).json({ error: 'read-only' });
    if (answering.has(sessionId)) return res.status(409).json({ error: 'busy' });
    answering.add(sessionId);
    try {
      const claude = await liveClaudeStatus(sessionId);
      const choices = await readScreenChoices(sessionId);
      if (claude?.status !== 'waiting') {
        // A menu Claude does not report (its trust dialog at startup) takes Enter as confirming
        // its highlighted option: the phone must not type the message there either.
        if (choices?.navigate) {
          logger.log(`reply to ${sessionId}: a menu is up while Claude reports nothing`);
          return res.status(409).json({ error: 'The prompt changed' });
        }
        // The phone composer sends here whenever Claude may be waiting; it is not, so the
        // phone types the message itself, which this case says apart from a changed prompt.
        logger.log(
          `reply to ${sessionId}: Claude is ${claude?.status ?? 'not reporting'}, typed as usual`
        );
        return res.status(409).json({ error: 'not-waiting' });
      }
      // A menu the phone saw must still be the one on screen. With none on either side Claude
      // waits on something nobody can read, and Esc is its "tell Claude what to do instead".
      // The phone saw a menu the server no longer finds: Claude moved on, maybe to work its
      // status file does not show yet, which Esc would interrupt.
      const phoneSawMenu =
        typeof question === 'string' || (Array.isArray(options) && options.length > 0);
      const stale = choices
        ? !sameMenu(sessionId, choices, req.body) || (choices.navigate && !takesReply(choices))
        : phoneSawMenu;
      if (stale) {
        logger.log(`reply to ${sessionId}: the prompt changed`);
        return res.status(409).json({ error: 'The prompt changed' });
      }
      choicesCache.delete(sessionId);
      if (choices?.keys) {
        logger.log(`reply to ${sessionId}: typed (a yes/no question)`);
        ptyManager.sendInput(sessionId, {
          text: text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text,
        });
        ptyManager.sendInput(sessionId, { key: 'enter' });
        return res.json({ success: true });
      }
      // Typed straight into the menu, Enter would confirm its highlighted option (a plan
      // correction would execute the plan).
      logger.log(`reply to ${sessionId}: Esc, then the text once Claude is back at its prompt`);
      ptyManager.sendInput(sessionId, { key: 'escape' });
      const typed = await typeWhenReady(sessionId, text, {
        timeoutMs: REPLY_TYPE_WAIT_MS,
        maxWaitMs: REPLY_TYPE_WAIT_MS,
      });
      if (!typed) {
        logger.warn(`reply to ${sessionId}: Claude did not get back to its prompt; not typed`);
        return res.status(504).json({ error: 'not-delivered' });
      }
      res.json({ success: true });
    } catch (error) {
      logger.error('error replying to prompt:', error);
      res.status(500).json({ error: 'Failed to reply' });
    } finally {
      answering.delete(sessionId);
    }
  });

  // Resize session
  router.post('/sessions/:sessionId/resize', async (req, res) => {
    const sessionId = req.params.sessionId;
    const { cols, rows } = req.body;

    if (typeof cols !== 'number' || typeof rows !== 'number') {
      logger.warn(`invalid resize request for session ${sessionId}: cols/rows not numbers`);
      return res.status(400).json({ error: 'Cols and rows must be numbers' });
    }

    if (cols < 1 || rows < 1 || cols > 1000 || rows > 1000) {
      logger.warn(
        `invalid resize request for session ${sessionId}: cols=${cols}, rows=${rows} out of range`
      );
      return res.status(400).json({ error: 'Cols and rows must be between 1 and 1000' });
    }

    // Log resize requests at debug level
    logger.debug(`Resizing session ${sessionId} to ${cols}x${rows}`);

    try {
      // If in HQ mode, check if this is a remote session
      if (isHQMode && remoteRegistry) {
        const remote = remoteRegistry.getRemoteBySessionId(sessionId);
        if (remote) {
          // Forward resize to remote server
          try {
            const response = await fetch(`${remote.url}/api/sessions/${sessionId}/resize`, {
              method: HttpMethod.POST,
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${remote.token}`,
              },
              body: JSON.stringify({ cols, rows }),
              signal: AbortSignal.timeout(5000),
            });

            if (!response.ok) {
              return res.status(response.status).json(await response.json());
            }

            return res.json(await response.json());
          } catch (error) {
            logger.error(`failed to resize session on remote ${remote.name}:`, error);
            return res.status(503).json({ error: 'Failed to reach remote server' });
          }
        }
      }

      // Local session handling
      const session = ptyManager.getSession(sessionId);
      if (!session) {
        logger.warn(`session ${sessionId} not found for resize`);
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.status !== 'running') {
        logger.warn(`session ${sessionId} is not running (status: ${session.status})`);
        return res.status(400).json({ error: 'Session is not running' });
      }

      // Resize the session
      ptyManager.resizeSession(sessionId, cols, rows);
      logger.log(chalk.green(`session ${sessionId} resized to ${cols}x${rows}`));

      res.json({ success: true, cols, rows });
    } catch (error) {
      logger.error('error resizing session via PTY service:', error);
      if (error instanceof PtyError) {
        res.status(500).json({ error: 'Failed to resize session', details: error.message });
      } else {
        res.status(500).json({ error: 'Failed to resize session' });
      }
    }
  });

  // Update session name
  router.patch('/sessions/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    logger.log(chalk.yellow(`[PATCH] Received rename request for session ${sessionId}`));
    logger.debug(`[PATCH] Request body:`, req.body);
    logger.debug(`[PATCH] Request headers:`, req.headers);

    const { name } = req.body;

    if (typeof name !== 'string' || name.trim() === '') {
      logger.warn(`[PATCH] Invalid name provided: ${JSON.stringify(name)}`);
      return res.status(400).json({ error: 'Name must be a non-empty string' });
    }

    logger.log(chalk.blue(`[PATCH] Updating session ${sessionId} name to: ${name}`));

    try {
      // If in HQ mode, check if this is a remote session
      if (isHQMode && remoteRegistry) {
        const remote = remoteRegistry.getRemoteBySessionId(sessionId);
        if (remote) {
          // Forward update to remote server
          try {
            const response = await fetch(`${remote.url}/api/sessions/${sessionId}`, {
              method: HttpMethod.PATCH,
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${remote.token}`,
              },
              body: JSON.stringify({ name }),
              signal: AbortSignal.timeout(5000),
            });

            if (!response.ok) {
              return res.status(response.status).json(await response.json());
            }

            return res.json(await response.json());
          } catch (error) {
            logger.error(`failed to update session name on remote ${remote.name}:`, error);
            return res.status(503).json({ error: 'Failed to reach remote server' });
          }
        }
      }

      // Local session handling
      logger.debug(`[PATCH] Handling local session update`);

      const session = ptyManager.getSession(sessionId);
      if (!session) {
        logger.warn(`[PATCH] Session ${sessionId} not found for name update`);
        return res.status(404).json({ error: 'Session not found' });
      }

      logger.debug(`[PATCH] Found session: ${JSON.stringify(session)}`);

      // Update the session name
      logger.debug(`[PATCH] Calling ptyManager.updateSessionName(${sessionId}, ${name})`);
      const uniqueName = ptyManager.updateSessionName(sessionId, name);
      logger.log(chalk.green(`[PATCH] Session ${sessionId} name updated to: ${uniqueName}`));

      res.json({ success: true, name: uniqueName });
    } catch (error) {
      logger.error('error updating session name:', error);
      if (error instanceof PtyError) {
        res.status(500).json({ error: 'Failed to update session name', details: error.message });
      } else {
        res.status(500).json({ error: 'Failed to update session name' });
      }
    }
  });

  // Reset terminal size (for external terminals)
  router.post('/sessions/:sessionId/reset-size', async (req, res) => {
    const { sessionId } = req.params;

    try {
      // In HQ mode, forward to remote if session belongs to one
      if (remoteRegistry) {
        const remote = remoteRegistry.getRemoteBySessionId(sessionId);
        if (remote) {
          logger.debug(`forwarding reset-size to remote ${remote.id}`);
          const response = await fetch(`${remote.url}/api/sessions/${sessionId}/reset-size`, {
            method: HttpMethod.POST,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${remote.token}`,
            },
          });

          if (!response.ok) {
            const error = await response.json();
            return res.status(response.status).json(error);
          }

          const result = await response.json();
          return res.json(result);
        }
      }

      logger.log(chalk.cyan(`resetting terminal size for session ${sessionId}`));

      // Check if session exists
      const session = ptyManager.getSession(sessionId);
      if (!session) {
        logger.error(`session ${sessionId} not found for reset-size`);
        return res.status(404).json({ error: 'Session not found' });
      }

      // Check if session is running
      if (session.status !== 'running') {
        logger.error(`session ${sessionId} is not running (status: ${session.status})`);
        return res.status(400).json({ error: 'Session is not running' });
      }

      // Reset the session size
      ptyManager.resetSessionSize(sessionId);
      logger.log(chalk.green(`session ${sessionId} size reset to terminal size`));

      res.json({ success: true });
    } catch (error) {
      logger.error('error resetting session size via PTY service:', error);
      if (error instanceof PtyError) {
        res.status(500).json({ error: 'Failed to reset session size', details: error.message });
      } else {
        res.status(500).json({ error: 'Failed to reset session size' });
      }
    }
  });

  return router;
}

// Generate recommendations based on Tailscale status
function generateTailscaleRecommendations(
  tailscaleStatus: { isRunning: boolean; output: string },
  serveStatus: { configured: boolean; error?: string }
): string[] {
  const recommendations: string[] = [];

  if (!tailscaleStatus.isRunning) {
    recommendations.push('Install and start Tailscale to enable secure access');
  } else if (!serveStatus.configured) {
    if (serveStatus.error) {
      recommendations.push(`Fix Tailscale Serve error: ${serveStatus.error}`);
    } else {
      recommendations.push('Enable Tailscale Serve integration in settings');
    }
  } else {
    recommendations.push('Tailscale integration is working correctly');
  }

  return recommendations;
}

// Generate a unique session ID
function generateSessionId(): string {
  // Generate UUID v4
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }

  // Set version (4) and variant bits
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  // Convert to hex string with dashes
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

// Request terminal spawn from Mac app via control socket
export async function requestTerminalSpawn(params: {
  sessionId: string;
  sessionName: string;
  command: string[];
  workingDir: string;
  titleMode?: TitleMode;
  gitRepoPath?: string;
  gitBranch?: string;
  gitAheadCount?: number;
  gitBehindCount?: number;
  gitHasChanges?: boolean;
  gitIsWorktree?: boolean;
  gitMainRepoPath?: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    // Create control message for terminal spawn
    const message = createControlMessage(
      'terminal',
      'spawn',
      {
        sessionId: params.sessionId,
        workingDirectory: params.workingDir,
        command: params.command.join(' '),
        terminalPreference: null, // Let Mac app use default terminal
        gitRepoPath: params.gitRepoPath,
        gitBranch: params.gitBranch,
        gitAheadCount: params.gitAheadCount,
        gitBehindCount: params.gitBehindCount,
        gitHasChanges: params.gitHasChanges,
        gitIsWorktree: params.gitIsWorktree,
        gitMainRepoPath: params.gitMainRepoPath,
      },
      params.sessionId
    );

    logger.debug(`requesting terminal spawn via control socket for session ${params.sessionId}`);

    // Send the message and wait for response
    const response = await controlUnixHandler.sendControlMessage(message);

    if (!response) {
      return {
        success: false,
        error: 'No response from Mac app',
      };
    }

    if (response.error) {
      return {
        success: false,
        error: response.error,
      };
    }

    const success = (response.payload as TerminalSpawnResponse)?.success === true;
    return {
      success,
      error: success ? undefined : 'Terminal spawn failed',
    };
  } catch (error) {
    logger.error('failed to spawn terminal:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
