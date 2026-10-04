import { DEFAULT_REPOSITORY_BASE_PATH } from '../shared/constants.js';
import type { MacOpenMode } from '../shared/mac-sessions.js';

export interface QuickStartCommand {
  name?: string; // Optional display name (can include emoji), if empty uses command
  command: string; // The actual command to execute
}

/**
 * Unified notification preferences used across Mac and Web
 * This is the single source of truth for notification settings
 */
export interface NotificationPreferences {
  enabled: boolean;
  sessionStart: boolean;
  sessionExit: boolean;
  commandCompletion: boolean;
  commandError: boolean;
  bell: boolean;
  // UI preferences
  soundEnabled: boolean;
  vibrationEnabled: boolean;
  /**
   * "Claude finished" / "Claude needs you" pushes from Claude Code's own status (the server
   * checks its sessions every 3 s while on). Off when missing.
   */
  agentStatus?: boolean;
}

export interface VibeTunnelConfig {
  version: number;
  quickStartCommands: QuickStartCommand[];
  repositoryBasePath?: string;
  /**
   * The phone chat view of agent conversations (Claude Code transcripts). Off when missing;
   * VIBETUNNEL_AGENT_CHAT=1|0 overrides it.
   */
  agentChat?: boolean;
  /**
   * Claude history on the phone: every Claude Code conversation from every project, with
   * resume. Off when missing; VIBETUNNEL_CLAUDE_HISTORY=1|0 overrides it. Never available on a
   * server started with --no-auth.
   */
  claudeHistory?: boolean;
  /**
   * "On this computer" in the phone's list: the tmux sessions on the user's own tmux servers and
   * the agents running outside VibeTunnel. Missing = off. --mac-sessions, --no-mac-sessions and
   * VIBETUNNEL_MAC_SESSIONS=0|1 override it (services/mac-sessions/settings.ts).
   */
  macSessions?: boolean;
  /** What a tap on a tmux session there opens. Missing = 'control' (ready to type). */
  macSessionsOpenMode?: MacOpenMode;
  /** Also list agents with no terminal, or a Claude not started from its CLI (an SDK client). */
  macSessionsIncludeHeadless?: boolean;
  /**
   * Absolute folders (`~` allowed) whose tmux sessions and agents are not listed, below them
   * included. VIBETUNNEL_MAC_SESSIONS_HIDE_IN adds to it; VIBETUNNEL_MAC_SESSIONS_ONLY_IN's
   * folders are listed even when hidden here.
   */
  macSessionsHideIn?: string[];

  // Extended configuration sections - matches Mac ConfigManager
  server?: {
    port: number;
    dashboardAccessMode: string;
    cleanupOnStartup: boolean;
    authenticationMode: string;
  };
  development?: {
    debugMode: boolean;
    useDevServer: boolean;
    devServerPath: string;
    logLevel: string;
  };
  preferences?: {
    preferredGitApp?: string;
    preferredTerminal?: string;
    updateChannel: string;
    showInDock: boolean;
    preventSleepWhenRunning: boolean;
    notifications?: NotificationPreferences;
  };
  remoteAccess?: {
    ngrokEnabled: boolean;
    ngrokTokenPresent: boolean;
  };
  sessionDefaults?: {
    command: string;
    workingDirectory: string;
    spawnWindow: boolean;
    titleMode: string;
  };
}

export const DEFAULT_QUICK_START_COMMANDS: QuickStartCommand[] = [
  { name: '✨ codex', command: 'codex' },
  { name: '✨ claude', command: 'claude' },
  { name: '✨ auggie', command: 'auggie' },
  { command: 'gemini3' },
  { command: 'opencode 4' },
  { command: 'zsh' },
  { command: 'node' },
];

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  enabled: false,
  sessionStart: false,
  sessionExit: true,
  commandCompletion: false,
  commandError: true,
  bell: true,
  soundEnabled: true,
  vibrationEnabled: false,
};

/**
 * Recommended notification preferences for new users
 * These are sensible defaults when notifications are enabled
 */
export const RECOMMENDED_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  enabled: true,
  sessionStart: false,
  sessionExit: true,
  commandCompletion: false,
  commandError: true,
  bell: true,
  soundEnabled: true,
  vibrationEnabled: false,
};

export const DEFAULT_CONFIG: VibeTunnelConfig = {
  version: 2,
  quickStartCommands: DEFAULT_QUICK_START_COMMANDS,
  repositoryBasePath: DEFAULT_REPOSITORY_BASE_PATH,
};
