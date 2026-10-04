/**
 * SessionManager - Centralized management for terminal session lifecycle and persistence
 *
 * This class provides a comprehensive solution for managing terminal sessions in VibeTunnel.
 * It handles session directory structure, metadata persistence, process tracking, and
 * file operations while maintaining compatibility with the tty-fwd format.
 *
 * ## Key Features:
 * - **Session Lifecycle Management**: Create, track, and cleanup terminal sessions
 * - **Persistent Storage**: Store session metadata and I/O streams in filesystem
 * - **Process Tracking**: Monitor running processes and detect zombie sessions
 * - **Version Management**: Handle cleanup across VibeTunnel version upgrades
 * - **Unique Naming**: Ensure session names are unique with automatic suffix handling
 * - **Atomic Operations**: Use temp files and rename for safe metadata updates
 *
 * ## Directory Structure:
 * ```
 * ~/.vibetunnel/control/
 * ├── .version                    # VibeTunnel version tracking
 * └── [session-id]/              # Per-session directory
 *     ├── session.json           # Session metadata
 *     ├── stdout                 # Process output stream
 *     └── stdin                  # Process input (FIFO or file)
 * ```
 *
 * ## Session States:
 * - `starting`: Session is being initialized
 * - `running`: Process is active and accepting input
 * - `exited`: Process has terminated
 *
 * @example
 * ```typescript
 * // Initialize session manager
 * const manager = new SessionManager();
 *
 * // Create a new session
 * const paths = manager.createSessionDirectory('session-123');
 *
 * // Save session metadata
 * manager.saveSessionInfo('session-123', {
 *   name: 'Development Server',
 *   status: 'starting',
 *   pid: 12345,
 *   startedAt: new Date().toISOString()
 * });
 *
 * // Update session status when process starts
 * manager.updateSessionStatus('session-123', 'running', 12345);
 *
 * // List all sessions
 * const sessions = manager.listSessions();
 * console.log(`Found ${sessions.length} sessions`);
 *
 * // Cleanup when done
 * manager.updateSessionStatus('session-123', 'exited', undefined, 0);
 * manager.cleanupSession('session-123');
 * ```
 */

import chalk from 'chalk';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Session, SessionInfo } from '../../shared/types.js';
import { createLogger } from '../utils/logger.js';
import { VERSION } from '../version.js';
import { ProcessUtils } from './process-utils.js';
import { PtyError } from './types.js';

const logger = createLogger('session-manager');

export class SessionManager {
  private controlPath: string;
  private static readonly SESSION_ID_REGEX = /^[a-zA-Z0-9_-]+$/;
  private sessionInfoCache = new Map<string, { key: string; info: SessionInfo | null }>();

  constructor(controlPath?: string) {
    this.controlPath = controlPath || path.join(os.homedir(), '.vibetunnel', 'control');
    logger.debug(`initializing session manager with control path: ${this.controlPath}`);
    this.ensureControlDirectory();
  }

  /**
   * Validate session ID format for security
   */
  private validateSessionId(sessionId: string): void {
    if (!SessionManager.SESSION_ID_REGEX.test(sessionId)) {
      throw new PtyError(
        `Invalid session ID format: "${sessionId}". Session IDs must only contain letters, numbers, hyphens (-), and underscores (_).`,
        'INVALID_SESSION_ID'
      );
    }
  }

  /**
   * Ensure the control directory exists
   */
  private ensureControlDirectory(): void {
    if (!fs.existsSync(this.controlPath)) {
      fs.mkdirSync(this.controlPath, { recursive: true });
      logger.debug(chalk.green(`control directory created: ${this.controlPath}`));
    }
  }

  /**
   * Get the path to the version tracking file
   */
  private getVersionFilePath(): string {
    return path.join(this.controlPath, '.version');
  }

  /**
   * Read the last known version from the version file
   */
  private readLastVersion(): string | null {
    try {
      const versionFile = this.getVersionFilePath();
      if (fs.existsSync(versionFile)) {
        const content = fs.readFileSync(versionFile, 'utf8').trim();
        logger.debug(`read last version from file: ${content}`);
        return content;
      }
      return null;
    } catch (error) {
      logger.warn(`failed to read version file: ${error}`);
      return null;
    }
  }

  /**
   * Write the current version to the version file
   */
  private writeCurrentVersion(): void {
    try {
      const versionFile = this.getVersionFilePath();
      fs.writeFileSync(versionFile, VERSION, 'utf8');
      logger.debug(`wrote current version to file: ${VERSION}`);
    } catch (error) {
      logger.warn(`failed to write version file: ${error}`);
    }
  }

  /**
   * Create a new session directory structure
   */
  createSessionDirectory(sessionId: string): {
    controlDir: string;
    stdoutPath: string;
    stdinPath: string;
    sessionJsonPath: string;
  } {
    this.validateSessionId(sessionId);
    const controlDir = path.join(this.controlPath, sessionId);

    // Create session directory
    if (!fs.existsSync(controlDir)) {
      fs.mkdirSync(controlDir, { recursive: true });
    }

    const paths = this.getSessionPaths(sessionId, true);
    if (!paths) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Create FIFO pipe for stdin (or regular file on systems without mkfifo)
    this.createStdinPipe(paths.stdinPath);
    logger.debug(chalk.green(`session directory created for ${sessionId}`));
    return paths;
  }

  /**
   * Create stdin pipe (FIFO if possible, regular file otherwise)
   */
  private createStdinPipe(stdinPath: string): void {
    try {
      // Try to create FIFO pipe (Unix-like systems)
      if (process.platform !== 'win32') {
        const result = spawnSync('mkfifo', [stdinPath], { stdio: 'ignore' });
        if (result.status === 0) {
          logger.debug(`FIFO pipe created: ${stdinPath}`);
          return; // Successfully created FIFO
        }
      }

      // Fallback to regular file
      if (!fs.existsSync(stdinPath)) {
        fs.writeFileSync(stdinPath, '');
      }
    } catch (error) {
      // If mkfifo fails, create regular file
      logger.debug(
        `mkfifo failed (${error instanceof Error ? error.message : 'unknown error'}), creating regular file: ${stdinPath}`
      );
      if (!fs.existsSync(stdinPath)) {
        fs.writeFileSync(stdinPath, '');
      }
    }
  }

  /**
   * Save session info to JSON file
   */
  saveSessionInfo(sessionId: string, sessionInfo: SessionInfo): void {
    this.validateSessionId(sessionId);
    try {
      const sessionDir = path.join(this.controlPath, sessionId);
      const sessionJsonPath = path.join(sessionDir, 'session.json');
      const tempPath = `${sessionJsonPath}.tmp`;

      // Ensure session directory exists before writing
      if (!fs.existsSync(sessionDir)) {
        logger.warn(`Session directory ${sessionDir} does not exist, creating it`);
        fs.mkdirSync(sessionDir, { recursive: true });
      }

      const sessionInfoStr = JSON.stringify(sessionInfo, null, 2);

      // Write to temporary file first, then move to final location (atomic write)
      fs.writeFileSync(tempPath, sessionInfoStr, 'utf8');

      // Double-check directory still exists before rename (handle race conditions)
      if (!fs.existsSync(sessionDir)) {
        logger.error(`Session directory ${sessionDir} was deleted during save operation`);
        // Clean up temp file if it exists
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
        throw new PtyError(
          `Session directory was deleted during save operation`,
          'SESSION_DIR_DELETED'
        );
      }

      fs.renameSync(tempPath, sessionJsonPath);
      logger.debug(
        `session.json file saved for session ${sessionId} with name: ${sessionInfo.name}`
      );
    } catch (error) {
      if (error instanceof PtyError) {
        throw error;
      }
      throw new PtyError(
        `Failed to save session info: ${error instanceof Error ? error.message : String(error)}`,
        'SAVE_SESSION_FAILED'
      );
    }
  }

  /**
   * Load session info from JSON file
   */
  loadSessionInfo(sessionId: string): SessionInfo | null {
    const sessionJsonPath = path.join(this.controlPath, sessionId, 'session.json');
    try {
      if (!fs.existsSync(sessionJsonPath)) {
        return null;
      }

      const content = fs.readFileSync(sessionJsonPath, 'utf8');
      const parsed = JSON.parse(content) as SessionInfo;

      // Defensive: legacy session.json files might have unexpected types.
      if (typeof parsed.gitRepoPath !== 'string') {
        delete (parsed as Partial<SessionInfo>).gitRepoPath;
      }
      if (typeof parsed.gitMainRepoPath !== 'string') {
        delete (parsed as Partial<SessionInfo>).gitMainRepoPath;
      }
      if (typeof parsed.gitBranch !== 'string') {
        delete (parsed as Partial<SessionInfo>).gitBranch;
      }

      return parsed;
    } catch (error) {
      logger.warn(`failed to load session info for ${sessionId}:`, error);
      return null;
    }
  }

  /**
   * Update session status
   */
  updateSessionStatus(sessionId: string, status: string, pid?: number, exitCode?: number): void {
    const sessionInfo = this.loadSessionInfo(sessionId);
    if (!sessionInfo) {
      throw new PtyError('Session info not found', 'SESSION_NOT_FOUND');
    }

    if (pid !== undefined) {
      sessionInfo.pid = pid;
    }
    sessionInfo.status = status as 'starting' | 'running' | 'exited';
    if (exitCode !== undefined) {
      sessionInfo.exitCode = exitCode;
    }

    this.saveSessionInfo(sessionId, sessionInfo);
    logger.debug(
      `session ${sessionId} status updated to ${status}${pid ? ` (pid: ${pid})` : ''}${exitCode !== undefined ? ` (exit code: ${exitCode})` : ''}`
    );
  }

  /**
   * Ensure a session name is unique by adding a suffix if necessary
   */
  private ensureUniqueName(desiredName: string, excludeSessionId?: string): string {
    const sessions = this.listSessions();
    let finalName = desiredName;
    let suffix = 2;

    // Keep checking until we find a unique name
    while (true) {
      const nameExists = sessions.some(
        (session) => session.name === finalName && session.id !== excludeSessionId
      );

      if (!nameExists) {
        break;
      }

      // Add or increment suffix
      finalName = `${desiredName} (${suffix})`;
      suffix++;
    }

    return finalName;
  }

  /**
   * Update session name
   */
  updateSessionName(sessionId: string, name: string): string {
    logger.debug(
      `[SessionManager] updateSessionName called for session ${sessionId} with name: ${name}`
    );

    const sessionInfo = this.loadSessionInfo(sessionId);
    if (!sessionInfo) {
      logger.error(`[SessionManager] Session info not found for ${sessionId}`);
      throw new PtyError('Session info not found', 'SESSION_NOT_FOUND');
    }

    logger.debug(`[SessionManager] Current session info: ${JSON.stringify(sessionInfo)}`);

    // Ensure the name is unique
    const uniqueName = this.ensureUniqueName(name, sessionId);

    if (uniqueName !== name) {
      logger.debug(`[SessionManager] Name "${name}" already exists, using "${uniqueName}" instead`);
    }

    sessionInfo.name = uniqueName;

    logger.debug(`[SessionManager] Updated session info: ${JSON.stringify(sessionInfo)}`);
    logger.debug(`[SessionManager] Calling saveSessionInfo`);

    this.saveSessionInfo(sessionId, sessionInfo);
    logger.debug(`[SessionManager] session ${sessionId} name updated to: ${uniqueName}`);

    return uniqueName;
  }

  /**
   * List all sessions
   */
  listSessions(): Session[] {
    return this.scanSessions().sessions;
  }

  /**
   * List all sessions, and which running sessions were just found dead (and marked exited).
   */
  listSessionsAndZombies(): { sessions: Session[]; zombies: string[] } {
    return this.scanSessions();
  }

  /**
   * session.json of a session, re-parsed only when the file changed (inode, mtime or size).
   * The returned object is shared with the cache: callers must not mutate it.
   *
   * GET /sessions (polled every second by each client) read and parsed every
   * session.json twice per request with sync fs (existsSync + readFileSync, plus a second full
   * scan for zombies): ~6 ms of blocked event loop per poll with 110 sessions.
   */
  private cachedSessionInfo(sessionId: string): SessionInfo | null {
    const sessionJsonPath = path.join(this.controlPath, sessionId, 'session.json');
    let stat: fs.Stats;
    try {
      stat = fs.statSync(sessionJsonPath);
    } catch {
      this.sessionInfoCache.delete(sessionId);
      return null;
    }
    const key = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    const cached = this.sessionInfoCache.get(sessionId);
    if (cached?.key === key) return cached.info;
    // An unreadable file is cached too: it is not re-read (and re-logged) until it changes.
    const info = this.loadSessionInfo(sessionId);
    this.sessionInfoCache.set(sessionId, { key, info });
    return info;
  }

  private scanSessions(): { sessions: Session[]; zombies: string[] } {
    try {
      const sessions: Session[] = [];
      const zombies: string[] = [];
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(this.controlPath, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          this.sessionInfoCache.clear();
          return { sessions, zombies };
        }
        throw error;
      }

      const seen = new Set<string>();
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const sessionId = entry.name;
        seen.add(sessionId);
        let sessionInfo = this.cachedSessionInfo(sessionId);
        if (!sessionInfo) continue;

        // Determine active state for running processes
        if (sessionInfo.status === 'running' && sessionInfo.pid) {
          // Update status if process is no longer alive
          if (!ProcessUtils.isProcessRunning(sessionInfo.pid)) {
            logger.debug(
              chalk.yellow(`process ${sessionInfo.pid} no longer running for session ${sessionId}`)
            );
            sessionInfo = {
              ...sessionInfo,
              status: 'exited',
              exitCode: sessionInfo.exitCode ?? 1, // Default exit code for dead processes
            };
            this.saveSessionInfo(sessionId, sessionInfo);
            zombies.push(sessionId);
          }
        }

        let lastModified = sessionInfo.startedAt;
        try {
          lastModified = fs
            .statSync(path.join(this.controlPath, sessionId, 'stdout'))
            .mtime.toISOString();
        } catch {
          // No output yet
        }
        sessions.push({ ...sessionInfo, id: sessionId, lastModified });
      }
      for (const sessionId of this.sessionInfoCache.keys()) {
        if (!seen.has(sessionId)) this.sessionInfoCache.delete(sessionId);
      }

      // Sort by startedAt timestamp (newest first)
      sessions.sort((a, b) => {
        const aTime = a.startedAt ? new Date(a.startedAt).getTime() : 0;
        const bTime = b.startedAt ? new Date(b.startedAt).getTime() : 0;
        return bTime - aTime;
      });

      // No log line here: the list is scanned on every client poll (each phone and tab, every
      // 1-3 s) and debug lines always reach the log file. A line per session filled the 50 MB
      // log in minutes; even one per call was ~30 MB/day per client.
      return { sessions, zombies };
    } catch (error) {
      throw new PtyError(
        `Failed to list sessions: ${error instanceof Error ? error.message : String(error)}`,
        'LIST_SESSIONS_FAILED'
      );
    }
  }

  /**
   * Check if a session exists
   */
  sessionExists(sessionId: string): boolean {
    const sessionDir = path.join(this.controlPath, sessionId);
    const sessionJsonPath = path.join(sessionDir, 'session.json');
    return fs.existsSync(sessionJsonPath);
  }

  /**
   * Cleanup a specific session
   */
  cleanupSession(sessionId: string): void {
    if (!sessionId) {
      throw new PtyError('Session ID is required for cleanup', 'INVALID_SESSION_ID');
    }

    try {
      const sessionDir = path.join(this.controlPath, sessionId);

      if (fs.existsSync(sessionDir)) {
        logger.debug(`Cleaning up session directory: ${sessionDir}`);

        // Log session info before cleanup for debugging
        const sessionInfo = this.loadSessionInfo(sessionId);
        if (sessionInfo) {
          logger.debug(`Cleaning up session ${sessionId} with status: ${sessionInfo.status}`);
        }

        // Remove directory and all contents
        fs.rmSync(sessionDir, { recursive: true, force: true });
        logger.debug(chalk.green(`session ${sessionId} cleaned up`));
      } else {
        logger.debug(`Session directory ${sessionDir} does not exist, nothing to clean up`);
      }
    } catch (error) {
      throw new PtyError(
        `Failed to cleanup session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        'CLEANUP_FAILED',
        sessionId
      );
    }
  }

  /**
   * Cleanup all exited sessions
   */
  cleanupExitedSessions(): string[] {
    const cleanedSessions: string[] = [];

    try {
      const sessions = this.listSessions();

      for (const session of sessions) {
        if (session.status === 'exited' && session.id) {
          this.cleanupSession(session.id);
          cleanedSessions.push(session.id);
        }
      }

      if (cleanedSessions.length > 0) {
        logger.debug(chalk.green(`cleaned up ${cleanedSessions.length} exited sessions`));
      }
      return cleanedSessions;
    } catch (error) {
      throw new PtyError(
        `Failed to cleanup exited sessions: ${error instanceof Error ? error.message : String(error)}`,
        'CLEANUP_EXITED_FAILED'
      );
    }
  }

  /**
   * Cleanup sessions from old VibeTunnel versions
   * This is called during server startup to clean sessions when version changes
   */
  cleanupOldVersionSessions(): { versionChanged: boolean; cleanedCount: number } {
    const lastVersion = this.readLastVersion();
    const currentVersion = VERSION;

    // If no version file exists, this is likely a fresh install or first time with version tracking
    if (!lastVersion) {
      logger.debug('no previous version found, checking for legacy sessions');

      // First update zombie sessions to mark dead processes
      this.updateZombieSessions();

      // Clean up any sessions without version field that are also not active
      let cleanedCount = 0;
      const sessions = this.listSessions();
      for (const session of sessions) {
        if (!session.version) {
          // Only clean if the session is not actively running
          if (
            session.status === 'exited' ||
            (session.pid && !ProcessUtils.isProcessRunning(session.pid))
          ) {
            logger.debug(`cleaning up legacy zombie session ${session.id} (no version field)`);
            this.cleanupSession(session.id);
            cleanedCount++;
          } else {
            logger.debug(`preserving active legacy session ${session.id}`);
          }
        }
      }

      this.writeCurrentVersion();
      return { versionChanged: false, cleanedCount };
    }

    // If version hasn't changed, nothing to do
    if (lastVersion === currentVersion) {
      logger.debug(`version unchanged (${currentVersion}), skipping cleanup`);
      return { versionChanged: false, cleanedCount: 0 };
    }

    logger.log(chalk.yellow(`VibeTunnel version changed from ${lastVersion} to ${currentVersion}`));
    logger.log(chalk.yellow('cleaning up zombie sessions from old version...'));

    // First update zombie sessions to mark dead processes
    this.updateZombieSessions();

    let cleanedCount = 0;
    try {
      const sessions = this.listSessions();

      for (const session of sessions) {
        // Only clean sessions that don't match the current version AND are not active
        if (!session.version || session.version !== currentVersion) {
          // Check if session is actually dead/zombie
          if (
            session.status === 'exited' ||
            (session.pid && !ProcessUtils.isProcessRunning(session.pid))
          ) {
            logger.debug(
              `cleaning up zombie session ${session.id} (version: ${session.version || 'unknown'})`
            );
            this.cleanupSession(session.id);
            cleanedCount++;
          } else {
            logger.debug(
              `preserving active session ${session.id} (version: ${session.version || 'unknown'})`
            );
          }
        }
      }

      // Update the version file to current version
      this.writeCurrentVersion();

      if (cleanedCount > 0) {
        logger.log(chalk.green(`cleaned up ${cleanedCount} zombie sessions from previous version`));
      } else {
        logger.log(chalk.gray('no zombie sessions to clean up (active sessions preserved)'));
      }

      return { versionChanged: true, cleanedCount };
    } catch (error) {
      logger.error(`failed to cleanup old version sessions: ${error}`);
      // Still update version file to prevent repeated cleanup attempts
      this.writeCurrentVersion();
      return { versionChanged: true, cleanedCount };
    }
  }

  /**
   * Get session paths for a given session ID
   */
  getSessionPaths(
    sessionId: string,
    checkExists: boolean = false
  ): {
    controlDir: string;
    stdoutPath: string;
    stdinPath: string;
    sessionJsonPath: string;
  } | null {
    const sessionDir = path.join(this.controlPath, sessionId);

    if (checkExists && !fs.existsSync(sessionDir)) {
      logger.debug(`[SessionManager] Session directory does not exist: ${sessionDir}`);
      return null;
    }

    return {
      controlDir: sessionDir,
      stdoutPath: path.join(sessionDir, 'stdout'),
      stdinPath: path.join(sessionDir, 'stdin'),
      sessionJsonPath: path.join(sessionDir, 'session.json'),
    };
  }

  /**
   * Write to stdin pipe/file
   */
  writeToStdin(sessionId: string, data: string): void {
    const paths = this.getSessionPaths(sessionId);
    if (!paths) {
      throw new PtyError(`Session ${sessionId} not found`, 'SESSION_NOT_FOUND', sessionId);
    }

    try {
      // For FIFO pipes, we need to open in append mode
      // For regular files, we also use append mode to avoid conflicts
      fs.appendFileSync(paths.stdinPath, data);
      logger.debug(`wrote ${data.length} bytes to stdin for session ${sessionId}`);
    } catch (error) {
      throw new PtyError(
        `Failed to write to stdin for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        'STDIN_WRITE_FAILED',
        sessionId
      );
    }
  }

  /**
   * Update sessions that have zombie processes
   */
  updateZombieSessions(): string[] {
    try {
      // The scan marks running sessions whose process is gone as exited.
      return this.scanSessions().zombies;
    } catch (error) {
      logger.warn('failed to update zombie sessions:', error);
      return [];
    }
  }

  /**
   * Get control path
   */
  getControlPath(): string {
    return this.controlPath;
  }
}
