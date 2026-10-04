/**
 * Shared type definitions used by both frontend and backend
 */

/**
 * HTTP methods enum
 */
export enum HttpMethod {
  GET = 'GET',
  POST = 'POST',
  PUT = 'PUT',
  DELETE = 'DELETE',
  PATCH = 'PATCH',
  HEAD = 'HEAD',
  OPTIONS = 'OPTIONS',
}

/**
 * Types of server events delivered over WebSocket v3 `EVENT` frames.
 * Matches the Swift ServerEventType enum for type safety across platforms.
 */
export enum ServerEventType {
  SessionStart = 'session-start',
  SessionExit = 'session-exit',
  CommandFinished = 'command-finished',
  CommandError = 'command-error',
  Bell = 'bell',
  Connected = 'connected',
  TestNotification = 'test-notification',
  /** `vt preview` in a session: viewers of that session show its dev-server preview. */
  PreviewOpen = 'preview-open',
}

/**
 * Server event delivered over WebSocket v3 `EVENT` frames.
 * Matches the Swift ServerEvent struct for cross-platform compatibility.
 */
export interface ServerEvent {
  type: ServerEventType;
  sessionId?: string;
  sessionName?: string;
  command?: string;
  exitCode?: number;
  duration?: number;
  processInfo?: string;
  message?: string;
  timestamp: string; // ISO 8601 format
  // Test notification specific fields
  title?: string;
  body?: string;
  // Preview open specific fields
  port?: number;
  path?: string;
  /** The persistent preview (its view is /preview/<previewId>). */
  previewId?: string;
}

/**
 * Session status enum
 */
export type SessionStatus = 'starting' | 'running' | 'exited';

/**
 * Core session information stored in session.json
 * Minimal, clean data persisted to disk
 */
export interface SessionInfo {
  id: string;
  name: string;
  command: string[];
  workingDir: string;
  status: SessionStatus;
  exitCode?: number;
  startedAt: string;
  pid?: number;
  initialCols?: number;
  initialRows?: number;
  /**
   * Byte offset of the last clear event in the session stdout file.
   * Used to quickly seek to the most recent content when replaying casts.
   */
  lastClearOffset?: number;
  version?: string; // VibeTunnel version that created this session
  gitRepoPath?: string; // Repository root path
  gitBranch?: string; // Current branch name
  gitAheadCount?: number; // Commits ahead of upstream
  gitBehindCount?: number; // Commits behind upstream
  gitHasChanges?: boolean; // Has uncommitted changes
  gitIsWorktree?: boolean; // Is a worktree (not main repo)
  gitMainRepoPath?: string; // Main repository path (same as gitRepoPath if not worktree)
  // Git status details (not persisted to disk, fetched dynamically)
  gitModifiedCount?: number; // Number of modified files
  gitUntrackedCount?: number; // Number of untracked files
  gitStagedCount?: number; // Number of staged files
  gitAddedCount?: number; // Number of added files
  gitDeletedCount?: number; // Number of deleted files
  gitInsertionCount?: number; // Number of inserted lines
  gitDeletionCount?: number; // Number of deleted lines
  /**
   * Whether this session was spawned from within VibeTunnel itself.
   * Used to distinguish between direct terminal sessions and nested VibeTunnel sessions.
   * Sessions with attachedViaVT=true are spawned from within an existing VibeTunnel session.
   */
  attachedViaVT?: boolean;
}

/**
 * Session as returned by API endpoints
 * Includes everything from SessionInfo plus additional runtime/computed fields
 */
export interface Session extends SessionInfo {
  lastModified: string;
  active?: boolean;

  activityStatus?: {
    isActive: boolean;
    lastActivityAt?: string;
  };

  // Source information (for HQ mode)
  source?: 'local' | 'remote';
  remoteId?: string;
  remoteName?: string;
  remoteUrl?: string;

  /** Dev servers seen in this session (announced in its output or opened with `vt preview`). */
  previewPorts?: PreviewPort[];
}

/** How a preview got into the list: `vt preview`, a URL in a session's output, or by hand. */
export type PreviewSource = 'detected' | 'vt-open' | 'manual';

/** A dev server a session opened or announced (its preview chip). */
export interface PreviewPort {
  /** The persistent preview's id: its view is `/preview/<id>`. */
  id?: string;
  port: number;
  /** URL as the dev server printed it. */
  url?: string;
  source: PreviewSource;
  /** Last opened or announced (epoch ms). */
  at: number;
  /** Server-side health check (every ~10 s): answering or not; absent until first checked. */
  state?: 'live' | 'down';
  /** The app's page <title> (or the name the user gave it). */
  title?: string;
}

/**
 * A persistent preview (GET /api/previews): one per loopback port, kept across sessions and
 * server restarts in previews.json.
 */
export interface PreviewItem {
  id: string;
  port: number;
  /** Page inside the app to open. */
  path: string;
  /** The app's page <title>, when the health check could read it. */
  title?: string;
  /** Name the user gave it (Rename). */
  customName?: string;
  createdAt: number;
  /** Last time its dev server answered (epoch ms). */
  lastSeenAt?: number;
  /** Last `vt preview`, announcement or manual add (epoch ms): newest first. */
  lastOpenedAt: number;
  /** Session that opened or announced it last (a link; it may be gone). */
  sessionId?: string;
  sessionName?: string;
  /** That session still exists on this server. */
  sessionAlive?: boolean;
  pinned: boolean;
  source: PreviewSource;
  /** Absent until the first health check. */
  state?: 'live' | 'down';
}

/**
 * A web server listening on this computer that isn't a preview yet
 * (GET /api/previews/candidates): one item of the "+ Add preview" sheet.
 */
export interface PreviewCandidate {
  port: number;
  /** Its page <title>, when `/` is an HTML page that has one. */
  title?: string;
  /** Process name as lsof reports it ("node", "Python"). */
  process?: string;
  /** Last part of the process's working directory (the project folder, usually). */
  folder?: string;
}

/**
 * Terminal title management modes
 */
export enum TitleMode {
  NONE = 'none', // No title management
  FILTER = 'filter', // Block all title changes from apps
  STATIC = 'static', // Static title: path — command — session
}

/**
 * Session creation options
 */
export interface SessionCreateOptions {
  sessionId?: string;
  name?: string;
  workingDir?: string;
  cols?: number;
  rows?: number;
  titleMode?: TitleMode;
  gitRepoPath?: string;
  gitBranch?: string;
  gitAheadCount?: number;
  gitBehindCount?: number;
  gitHasChanges?: boolean;
  gitIsWorktree?: boolean;
  gitMainRepoPath?: string;
}

/**
 * Session input (keyboard/special keys)
 */
export interface SessionInput {
  text?: string;
  key?: SpecialKey;
}

/**
 * Special keys that can be sent to sessions
 */
export type SpecialKey =
  | 'arrow_up'
  | 'arrow_down'
  | 'arrow_left'
  | 'arrow_right'
  | 'escape'
  | 'enter'
  | 'ctrl_enter'
  | 'shift_enter'
  | 'backspace'
  | 'tab'
  | 'shift_tab'
  | 'page_up'
  | 'page_down'
  | 'home'
  | 'end'
  | 'delete'
  | 'f1'
  | 'f2'
  | 'f3'
  | 'f4'
  | 'f5'
  | 'f6'
  | 'f7'
  | 'f8'
  | 'f9'
  | 'f10'
  | 'f11'
  | 'f12';

/**
 * Push notification subscription
 */
export interface PushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/**
 * Stored push subscription with metadata
 */
export interface StoredPushSubscription extends PushSubscription {
  id: string;
  deviceId: string;
  userAgent?: string;
  createdAt: string;
  lastUsed: string;
}

/**
 * Push notification preferences
 */
export interface PushNotificationPreferences {
  enabled: boolean;
  sessionExit: boolean;
  sessionStart: boolean;
  sessionError: boolean;
  commandNotifications: boolean;
  systemAlerts: boolean;
  soundEnabled: boolean;
  vibrationEnabled: boolean;
}

/**
 * Push notification types
 */
export type PushNotificationType =
  | 'session_exit'
  | 'session_start'
  | 'session_error'
  | 'system_alert'
  | 'test';

/**
 * Push notification data
 */
export interface PushNotificationData {
  type: PushNotificationType;
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  data?: Record<string, unknown>;
  actions?: Array<{
    action: string;
    title: string;
    icon?: string;
  }>;
  requireInteraction?: boolean;
  silent?: boolean;
}

/**
 * Push notification history entry
 */
export interface PushNotificationHistoryEntry {
  id: string;
  timestamp: string;
  type: PushNotificationType;
  title: string;
  body: string;
  success: boolean;
  error?: string;
  deviceId?: string;
}

/**
 * Device registration for push notifications
 */
export interface PushDeviceRegistration {
  deviceId: string;
  subscription: PushSubscription;
  userAgent?: string;
}

/**
 * Server status information
 */
export interface ServerStatus {
  macAppConnected: boolean;
  isHQMode: boolean;
  version: string;
}
