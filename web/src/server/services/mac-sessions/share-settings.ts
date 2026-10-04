/**
 * "Share with phone" settings (shared/mac-share.ts): whether an idle agent in a Terminal or
 * iTerm2 tab can be closed there and reopened through vt, and how the line is typed.
 *
 * Off unless turned on. The switch can be forced when the server starts, and Settings then
 * shows it locked: --mac-share turns it on, --no-mac-share off (and wins over --mac-share),
 * VIBETUNNEL_MAC_SHARE=0|1 off or on. Otherwise config.json's `macShare` decides, and a missing
 * one means off (CLI > env > config > default). Even when on, it only works on macOS (Terminal
 * and iTerm2 are scripted with AppleScript), with "On this computer" listing, with a login (it acts on processes and windows the user didn't open in VibeTunnel),
 * and never in HQ mode.
 */
import * as path from 'path';
import {
  MAC_SHARE_START_TIMEOUT_SEC,
  type MacShareLauncher,
  type MacShareOffReason,
} from '../../../shared/mac-share.js';
import type { VibeTunnelConfig } from '../../../types/config.js';
import {
  type MacSessionsConfig,
  type MacSessionsStartOptions,
  macSessionsSettings,
} from './settings.js';

export const MAC_SHARE_CLI_FLAG = '--no-mac-share';
export const MAC_SHARE_CLI_ENABLE_FLAG = '--mac-share';
export const MAC_SHARE_ENV = 'VIBETUNNEL_MAC_SHARE';

/** Bounds of macShareStartTimeoutSec, also enforced by the config schema. */
export const MAC_SHARE_START_TIMEOUT_MIN_SEC = 5;
export const MAC_SHARE_START_TIMEOUT_MAX_SEC = 300;

/** How the server was started: Mac Sessions' options plus this feature's own. */
export interface MacShareStartOptions extends MacSessionsStartOptions {
  /** Started with --no-mac-share. */
  shareCliDisabled?: boolean;
  /** Started with --mac-share (--no-mac-share wins if both are given). */
  shareCliEnabled?: boolean;
  /** Started with --no-auth. */
  noAuth?: boolean;
}

export interface MacShareSettings {
  /** The switch: forced at start (see lockedBy), else config.json; missing means off. */
  on: boolean;
  /** What forced the switch, as Settings names it ("VIBETUNNEL_MAC_SHARE=1"). */
  lockedBy?: string;
  /** False off macOS and in HQ mode: Settings hides the switch. */
  supported: boolean;
  /** Offered and served: on, supported, Mac Sessions listing, and a login. */
  enabled: boolean;
  reason?: MacShareOffReason;
  launcher: MacShareLauncher;
  /** An absolute vt to type instead of the bare `vt`. */
  vtPath?: string;
  /**
   * Answer the exact trust dialog of the same folder (rule in the share job). Off unless
   * config.json has `macShareAutoTrust: true`: answering an agent's trust prompt on the user's
   * behalf is a security decision the user makes.
   */
  autoTrust: boolean;
  startTimeoutSec: number;
}

export type MacShareConfig = MacSessionsConfig &
  Pick<
    VibeTunnelConfig,
    | 'macShare'
    | 'macShareLauncher'
    | 'macShareVtPath'
    | 'macShareAutoTrust'
    | 'macShareStartTimeoutSec'
  >;

/** The env variable as a forced value; unset or not a yes/no word forces nothing. */
function envSwitch(raw: string | undefined): boolean | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === '1' || value === 'true' || value === 'on' || value === 'yes') return true;
  if (value === '0' || value === 'false' || value === 'off' || value === 'no') return false;
  return undefined;
}

function offReason(
  on: boolean,
  config: MacShareConfig,
  options: MacShareStartOptions
): MacShareOffReason | undefined {
  if (options.hqMode) return 'hq';
  if ((options.platform ?? process.platform) !== 'darwin') return 'unsupported';
  if (!on) return 'disabled';
  if (!macSessionsSettings(config, options).enabled) return 'mac-sessions-off';
  if (options.noAuth) return 'no-auth';
  return undefined;
}

function startTimeout(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return MAC_SHARE_START_TIMEOUT_SEC;
  return Math.min(
    MAC_SHARE_START_TIMEOUT_MAX_SEC,
    Math.max(MAC_SHARE_START_TIMEOUT_MIN_SEC, value)
  );
}

export function macShareSettings(
  config: MacShareConfig,
  options: MacShareStartOptions = {}
): MacShareSettings {
  const forced = envSwitch((options.env ?? process.env)[MAC_SHARE_ENV]);
  let on = config.macShare === true;
  let lockedBy: string | undefined;
  if (options.shareCliDisabled) {
    on = false;
    lockedBy = MAC_SHARE_CLI_FLAG;
  } else if (options.shareCliEnabled) {
    on = true;
    lockedBy = MAC_SHARE_CLI_ENABLE_FLAG;
  } else if (forced !== undefined) {
    on = forced;
    lockedBy = `${MAC_SHARE_ENV}=${forced ? '1' : '0'}`;
  }
  const reason = offReason(on, config, options);
  const vtPath = config.macShareVtPath;
  return {
    on,
    ...(lockedBy ? { lockedBy } : {}),
    supported: reason !== 'hq' && reason !== 'unsupported',
    enabled: reason === undefined,
    ...(reason ? { reason } : {}),
    launcher: config.macShareLauncher === 'shell' ? 'shell' : 'vt',
    ...(typeof vtPath === 'string' && path.isAbsolute(vtPath) ? { vtPath } : {}),
    autoTrust: config.macShareAutoTrust === true,
    startTimeoutSec: startTimeout(config.macShareStartTimeoutSec),
  };
}
