import * as fs from 'fs';
import * as path from 'path';

/** A shell found on this machine, run without any startup file. */
export interface TestShell {
  label: string;
  bin: string;
  flags: string[];
  fish: boolean;
}

/**
 * The shells a machine must have for the real-shell tests to mean something: macOS always
 * ships zsh and bash, Linux CI runners only bash (zsh tests are skipped there).
 */
export const REQUIRED_TEST_SHELLS: readonly string[] =
  process.platform === 'darwin' ? ['zsh', 'bash'] : ['bash'];

/** zsh, bash, sh, dash, ksh and fish, the ones installed (fish is optional on macOS). */
export function findShells(): TestShell[] {
  const candidates: TestShell[] = [
    { label: 'zsh', bin: '/bin/zsh', flags: ['-f'], fish: false },
    { label: 'bash', bin: '/bin/bash', flags: ['--norc', '--noprofile'], fish: false },
    { label: 'sh', bin: '/bin/sh', flags: [], fish: false },
    { label: 'dash', bin: '/bin/dash', flags: [], fish: false },
    { label: 'ksh', bin: '/bin/ksh', flags: [], fish: false },
  ];
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
    const fish = path.join(dir, 'fish');
    if (fs.existsSync(fish)) {
      candidates.push({ label: 'fish', bin: fish, flags: ['--no-config'], fish: true });
      break;
    }
  }
  return candidates.filter((shell) => fs.existsSync(shell.bin));
}
