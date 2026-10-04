import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export default function globalSetup(): void {
  // A unit test that leaves the Serve service marked running makes its afterEach stop() run a
  // real `tailscale serve reset`, which wipes every Tailscale Serve route on the developer's
  // machine, other apps' included. Workers inherit this env, so every test talks to a fake
  // binary unless live Tailscale tests are requested with ENABLE_TAILSCALE_TESTS=1.
  if (!process.env.ENABLE_TAILSCALE_TESTS) {
    const fake = join(mkdtempSync(join(tmpdir(), 'vibetunnel-fake-tailscale-')), 'tailscale');
    writeFileSync(fake, '#!/bin/sh\necho "$@" >> "$0.calls"\nexit 0\n', { mode: 0o755 });
    process.env.VIBETUNNEL_TAILSCALE_BIN = fake;
  }

  // A tmux command run without -S/-L talks to the server named in $TMUX. Run from inside a tmux
  // session, a test's cleanup (`tmux kill-server`, even with a private TMUX_TMPDIR) would kill
  // the developer's own tmux server and every session in it. Workers inherit this env, so no
  // test ever sees the developer's tmux.
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  // Likewise, run from inside a VibeTunnel session, `vt` refuses to start ("Already inside a
  // VibeTunnel session") and the vt wrapper tests fail for that developer only.
  delete process.env.VIBETUNNEL_SESSION_ID;

  // No port sweep here. It used to SIGKILL every listener on TCP 3000-3005 to clear test
  // servers left by a crashed run, but test servers listen on port 0, so it only ever hit
  // unrelated apps the developer had running on those ports. Tests stop only the processes
  // they started; a port clash fails the test that hit it.
}
