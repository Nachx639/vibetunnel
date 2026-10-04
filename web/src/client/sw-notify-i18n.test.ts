import { describe, expect, it } from 'vitest';
import { isNotifyStrings, localizeNotification } from './sw-notify-i18n.js';

const fr = {
  needsYou: '⏳ Claude a besoin de vous · {where}',
  finished: '✅ Claude a terminé · {where}',
  waiting: 'En attente de votre réponse',
  yourTurn: 'À vous',
  open: 'Ouvrir',
  dismiss: 'Ignorer',
};

const payload = (type: string, detail = '') => ({
  title: `English ${type}`,
  body: 'English body',
  actions: [
    { action: 'view-session', title: 'Open' },
    { action: 'dismiss', title: 'Dismiss' },
  ],
  data: { type, where: 'api-server', detail },
});

describe('localizeNotification', () => {
  it('rebuilds a "needs you" notification in the stored language', () => {
    const out = localizeNotification(payload('claude-waiting'), fr);
    expect(out.title).toBe('⏳ Claude a besoin de vous · api-server');
    expect(out.body).toBe('En attente de votre réponse');
    expect(out.actions?.map((a) => a.title)).toEqual(['Ouvrir', 'Ignorer']);
  });

  it("keeps Claude's own words as the body", () => {
    const out = localizeNotification(payload('claude-finished', 'All tests pass'), fr);
    expect(out.title).toBe('✅ Claude a terminé · api-server');
    expect(out.body).toBe('All tests pass');
  });

  it('rebuilds a failed-command notification with its exit code and duration', () => {
    const strings = {
      ...fr,
      commandFailed: '❌ Échec : {where}',
      commandFailedBody: 'Code de sortie {code} · {duration}',
    };
    const failed = {
      ...payload('command-error', '12s'),
      data: { type: 'command-error', where: 'npm test', detail: '12s', exitCode: 1 },
    };
    const out = localizeNotification(failed, strings);
    expect(out.title).toBe('❌ Échec : npm test');
    expect(out.body).toBe('Code de sortie 1 · 12s');
  });

  it('rebuilds a bell notification, and leaves it alone with strings from an older app', () => {
    const withBell = { ...fr, attention: '🔔 {where} demande votre attention', bellBody: 'Bip' };
    const out = localizeNotification(payload('bell'), withBell);
    expect(out.title).toBe('🔔 api-server demande votre attention');
    expect(out.body).toBe('Bip');
    expect(localizeNotification(payload('bell'), fr).title).toBe('English bell');
  });

  it('keeps a "$" in the session name literally', () => {
    const named = {
      ...payload('claude-waiting'),
      data: { type: 'claude-waiting', where: "cost $' fix $$", detail: '' },
    };
    expect(localizeNotification(named, fr).title).toBe(
      "⏳ Claude a besoin de vous · cost $' fix $$"
    );
  });

  it('only trusts a cached string set with every field', () => {
    expect(isNotifyStrings(fr)).toBe(true);
    expect(isNotifyStrings({ ...fr, finished: undefined })).toBe(false);
    expect(isNotifyStrings(null)).toBe(false);
  });

  it('leaves other notifications, pushes without raw fields and missing strings alone', () => {
    const other = payload('session-exit');
    expect(localizeNotification(other, fr)).toBe(other);
    const legacy = { title: 'Claude needs you', body: 'x', data: { type: 'claude-waiting' } };
    expect(localizeNotification(legacy, fr)).toBe(legacy);
    const waiting = payload('claude-waiting');
    expect(localizeNotification(waiting, null)).toBe(waiting);
  });
});
