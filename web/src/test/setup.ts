// Global test setup for Vitest

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'crypto';
import { vi } from 'vitest';
import { MockFitAddon, MockTerminal } from './utils/terminal-mocks';

// Mock ghostty-web (WASM/canvas) for unit tests
vi.mock('ghostty-web', () => ({
  Ghostty: { load: vi.fn(async () => ({})) },
  Terminal: MockTerminal,
  FitAddon: MockFitAddon,
}));

// Server tests never touch the real home: a test that saves state (push subscriptions,
// config, control dir) would otherwise write into the developer's ~/.vibetunnel, which a
// running VibeTunnel server reads. Set VIBETUNNEL_TEST_REAL_HOME=1 to opt out.
if (typeof window === 'undefined' && !process.env.VIBETUNNEL_TEST_REAL_HOME) {
  if (!process.env.HOME?.startsWith(tmpdir())) {
    // Inside the run's directory (global-setup.ts), removed when the run ends.
    const parent = process.env.VIBETUNNEL_TEST_RUN_DIR ?? tmpdir();
    process.env.HOME = mkdtempSync(join(parent, 'home-'));
  }
  // These move the agents' data out of HOME: set in the developer's shell, tests would read
  // (and could write) their real Claude, Codex and Gemini folders.
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  delete process.env.GEMINI_CLI_HOME;
}

// Disable SEA loader for tests
process.env.VIBETUNNEL_SEA = '';
// Prevent spawned test servers from creating persistent signing material in the real home.
process.env.JWT_SECRET ??= 'vibetunnel-test-only-jwt-secret';

// Polyfill crypto for Node.js environments
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
  });
}

// Mock the native pty module before any imports
vi.mock('node-pty', () => {
  // Create a more complete mock that simulates PTY behavior
  const createMockPty = (command: string, args: string[]) => {
    let dataCallback: ((data: string) => void) | null = null;
    let exitCallback: ((exitInfo: { exitCode: number; signal?: number }) => void) | null = null;
    let isKilled = false;
    let cols = 80;
    let rows = 24;

    const mockPty = {
      pid: Math.floor(Math.random() * 10000) + 1000,
      cols,
      rows,
      process: command,
      handleFlowControl: false,
      on: vi.fn(),
      resize: vi.fn((newCols: number, newRows: number) => {
        cols = newCols;
        rows = newRows;
      }),
      write: vi.fn((data: string) => {
        // Simulate echo behavior for 'cat' command
        if (command === 'sh' && args[0] === '-c' && args[1] === 'cat' && dataCallback) {
          // Echo back the input
          setTimeout(() => {
            if (!isKilled && dataCallback) {
              dataCallback(data);
            }
          }, 10);
        }
      }),
      kill: vi.fn((signal?: string) => {
        isKilled = true;
        // Simulate process exit
        if (exitCallback) {
          setTimeout(() => {
            exitCallback?.({ exitCode: signal === 'SIGTERM' ? 143 : 137, signal: 15 });
          }, 50);
        }
      }),
      onData: vi.fn((callback: (data: string) => void) => {
        dataCallback = callback;
        // For 'echo' command, immediately output but don't exit yet
        if (command === 'echo' && args[0] === 'test') {
          setTimeout(() => {
            if (dataCallback) dataCallback('test\n');
            // Don't exit immediately - let the test control when to exit
          }, 10);
        }
      }),
      onExit: vi.fn((callback: (exitInfo: { exitCode: number; signal?: number }) => void) => {
        exitCallback = callback;
        // For 'exit' command, exit immediately
        if (command === 'exit') {
          setTimeout(() => {
            if (exitCallback) exitCallback({ exitCode: 0 });
          }, 10);
        }
        // For 'echo' command, exit after a longer delay
        if (command === 'echo') {
          setTimeout(() => {
            if (!isKilled && exitCallback) exitCallback({ exitCode: 0 });
          }, 2000); // Wait 2 seconds before exiting
        }
      }),
    };

    return mockPty;
  };

  return {
    spawn: vi.fn((command: string, args: string[], _options: unknown) => {
      return createMockPty(command, args);
    }),
  };
});

// Mock global objects that might not exist in test environments
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mock IntersectionObserver
global.IntersectionObserver = class IntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  root = null;
  rootMargin = '';
  scrollMargin = '';
  thresholds = [];
};

// Mock localStorage for tests
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  length: 0,
  key: vi.fn(),
};

// Add localStorage to global scope
if (typeof global !== 'undefined') {
  // biome-ignore lint/suspicious/noExplicitAny: Test setup requires any for global mocking
  (global as any).localStorage = localStorageMock;
}

// Prevent duplicate custom element registration in tests (a module re-imported after
// vi.resetModules() defines its elements again). Wrap define once: re-wrapping before every
// test stacked wrappers that shared a "seen" set, so the outer one marked a name and the inner
// one skipped it, and any element first imported inside a test was never registered.
// The real registry is the only source of truth.
const PATCHED = Symbol.for('vibetunnel.test.customElementsPatched');

function patchCustomElements() {
  if (typeof window === 'undefined' || !window.customElements) return;
  const registry = window.customElements as CustomElementRegistry & { [PATCHED]?: boolean };
  if (registry[PATCHED]) return;
  const originalDefine = registry.define.bind(registry);
  registry.define = (
    name: string,
    elementConstructor: CustomElementConstructor,
    options?: ElementDefinitionOptions
  ) => {
    if (registry.get(name)) return;
    originalDefine(name, elementConstructor, options);
  };
  registry[PATCHED] = true;
}

// Apply patch immediately for module imports
patchCustomElements();

// Re-apply before each test in case the environment swapped the registry (no-op otherwise)
beforeEach(() => {
  patchCustomElements();
});
// Mock matchMedia (only if window exists - for browser tests)
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  // Also add localStorage to window for browser tests
  // biome-ignore lint/suspicious/noExplicitAny: Test setup requires any for window mocking
  (window as any).localStorage = localStorageMock;
}

// Mock WebSocket for tests that need it
global.WebSocket = class WebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState: number = WebSocket.CONNECTING;
  binaryType: 'blob' | 'arraybuffer' = 'blob';

  constructor(url: string) {
    super();
    this.url = url;
  }

  send() {}
  close() {
    this.readyState = WebSocket.CLOSED;
  }
} as unknown as typeof WebSocket;

// Set up fetch mock (only for non-e2e tests)
if (typeof window !== 'undefined') {
  global.fetch = vi.fn();
}

// Server tests never reach a VibeTunnel server running on this machine. A relay that is not
// stubbed (the API socket's git-event relay, for one) would otherwise POST to the default
// port 4020, or 4021 (`pnpm dev:mobile`), of the developer's own server. Tests that need HTTP
// start their own server on port 0 or stub fetch. Add more ports with
// VIBETUNNEL_TEST_BLOCK_PORTS=4100,4101. Only `fetch` to the loopback names below is guarded:
// http.request (supertest) and 0.0.0.0 or a LAN address are not.
if (typeof window === 'undefined' && typeof globalThis.fetch === 'function') {
  const realFetch = globalThis.fetch.bind(globalThis);
  const blockedPorts = new Set([
    '4020',
    '4021',
    ...(process.env.VIBETUNNEL_TEST_BLOCK_PORTS ?? '')
      .split(',')
      .map((port) => port.trim())
      .filter(Boolean),
  ]);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let url: URL | null = null;
    try {
      url = new URL(href);
    } catch {
      url = null;
    }
    if (
      url &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      blockedPorts.has(url.port)
    ) {
      throw new Error(`test tried to reach a local VibeTunnel server at ${url.host}: stub fetch`);
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

// Configure console to reduce noise in tests
const originalError = console.error;
const originalWarn = console.warn;

beforeAll(() => {
  // Suppress specific console errors/warnings during tests
  console.error = (...args: unknown[]) => {
    if (
      typeof args[0] === 'string' &&
      (args[0].includes('Not implemented') || args[0].includes('Failed to fetch'))
    ) {
      return;
    }
    originalError.call(console, ...args);
  };

  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('LitElement')) {
      return;
    }
    originalWarn.call(console, ...args);
  };
});

afterAll(() => {
  console.error = originalError;
  console.warn = originalWarn;
});

// Patch addEventListener for custom elements in test environment
// This is to handle cases where vibe-terminal is created but doesn't have addEventListener
if (typeof window !== 'undefined') {
  const originalCreateElement = document.createElement;
  document.createElement = function (tagName: string) {
    const element = originalCreateElement.call(this, tagName);

    // Add addEventListener if it's missing for vibe-terminal elements
    if (tagName === 'vibe-terminal' && !element.addEventListener) {
      element.addEventListener = vi.fn();
      element.removeEventListener = vi.fn();
    }

    return element;
  };
}

// Force garbage collection between test suites if available
afterEach(() => {
  if (global.gc) {
    global.gc();
  }
});
