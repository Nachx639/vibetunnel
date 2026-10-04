import { describe, expect, it } from 'vitest';
import { type MacShareStartOptions, macShareSettings } from './share-settings.js';

// Never the real environment: a developer's VIBETUNNEL_MAC_SHARE must not change the answers.
const mac: MacShareStartOptions = { env: {}, platform: 'darwin' };
const withEnv = (value: string): MacShareStartOptions => ({
  ...mac,
  env: { VIBETUNNEL_MAC_SHARE: value },
});

describe('Share with phone settings', () => {
  it('is off by default, types vt, and never answers a trust dialog', () => {
    expect(macShareSettings({}, mac)).toEqual({
      on: false,
      supported: true,
      enabled: false,
      reason: 'disabled',
      launcher: 'vt',
      autoTrust: false,
      startTimeoutSec: 30,
    });
  });

  it('follows config.json when nothing forces the switch', () => {
    expect(
      macShareSettings(
        {
          macSessions: true,
          macShare: true,
          macShareLauncher: 'shell',
          macShareVtPath: '/opt/vt/bin/vt',
          macShareAutoTrust: false,
          macShareStartTimeoutSec: 45,
        },
        mac
      )
    ).toEqual({
      on: true,
      supported: true,
      enabled: true,
      launcher: 'shell',
      vtPath: '/opt/vt/bin/vt',
      autoTrust: false,
      startTimeoutSec: 45,
    });
  });

  it('VIBETUNNEL_MAC_SHARE forces the switch either way and says so', () => {
    expect(macShareSettings({ macSessions: true }, withEnv('1'))).toMatchObject({
      on: true,
      enabled: true,
      lockedBy: 'VIBETUNNEL_MAC_SHARE=1',
    });
    expect(macShareSettings({ macShare: true }, withEnv(' off '))).toMatchObject({
      on: false,
      enabled: false,
      reason: 'disabled',
      lockedBy: 'VIBETUNNEL_MAC_SHARE=0',
    });
    for (const value of ['', 'maybe', '2']) {
      expect(macShareSettings({ macShare: true }, withEnv(value)).lockedBy, value).toBeUndefined();
    }
  });

  it('--no-mac-share beats the env and config.json', () => {
    expect(
      macShareSettings({ macShare: true }, { ...withEnv('1'), shareCliDisabled: true })
    ).toMatchObject({ on: false, enabled: false, lockedBy: '--no-mac-share' });
  });

  it('--mac-share turns it on over the env and config.json; --no-mac-share still wins', () => {
    expect(
      macShareSettings(
        { macSessions: true, macShare: false },
        { ...withEnv('0'), shareCliEnabled: true }
      )
    ).toMatchObject({ on: true, enabled: true, lockedBy: '--mac-share' });
    expect(
      macShareSettings(
        { macShare: true },
        { ...mac, shareCliEnabled: true, shareCliDisabled: true }
      )
    ).toMatchObject({ on: false, lockedBy: '--no-mac-share' });
  });

  it('answers a trust dialog only when config.json says so explicitly', () => {
    const on = { macSessions: true, macShare: true };
    expect(macShareSettings(on, mac).autoTrust).toBe(false);
    expect(macShareSettings({ ...on, macShareAutoTrust: false }, mac).autoTrust).toBe(false);
    expect(macShareSettings({ ...on, macShareAutoTrust: true }, mac).autoTrust).toBe(true);
  });

  it('only works on macOS, never in HQ mode', () => {
    for (const platform of ['linux', 'win32'] as const) {
      expect(macShareSettings({ macShare: true }, { ...mac, platform })).toMatchObject({
        on: true,
        supported: false,
        enabled: false,
        reason: 'unsupported',
      });
    }
    expect(macShareSettings({ macShare: true }, { ...mac, hqMode: true })).toMatchObject({
      supported: false,
      enabled: false,
      reason: 'hq',
    });
  });

  it('needs "On this computer" listing and a login, even when on', () => {
    expect(macShareSettings({ macShare: true, macSessions: false }, mac)).toMatchObject({
      on: true,
      supported: true,
      enabled: false,
      reason: 'mac-sessions-off',
    });
    expect(
      macShareSettings({ macShare: true }, { ...mac, env: { VIBETUNNEL_MAC_SESSIONS: '0' } })
    ).toMatchObject({ enabled: false, reason: 'mac-sessions-off' });
    expect(
      macShareSettings({ macSessions: true, macShare: true }, { ...mac, noAuth: true })
    ).toMatchObject({
      on: true,
      enabled: false,
      reason: 'no-auth',
    });
  });

  it('ignores a relative vt path and keeps the start timeout within bounds', () => {
    const settings = macShareSettings(
      // Values a hand edit could leave if the schema were bypassed.
      { macShareVtPath: 'bin/vt', macShareStartTimeoutSec: 1 },
      mac
    );
    expect(settings).not.toHaveProperty('vtPath');
    expect(settings.startTimeoutSec).toBe(5);
    expect(macShareSettings({ macShareStartTimeoutSec: 10_000 }, mac).startTimeoutSec).toBe(300);
    expect(macShareSettings({ macShareStartTimeoutSec: 2.5 }, mac).startTimeoutSec).toBe(30);
  });
});
