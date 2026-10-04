import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeLogger,
  createLogger,
  flushLogger,
  logFromModule,
  setLogFilePath,
  setVerbosityLevel,
  VerbosityLevel,
} from '../../server/utils/logger';

describe('logger file output by level', () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibetunnel-logger-debug-'));
    logPath = path.join(tempDir, 'server.log');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setLogFilePath(logPath);
  });

  afterEach(async () => {
    await flushLogger();
    closeLogger();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    setVerbosityLevel(VerbosityLevel.ERROR);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeAll() {
    const logger = createLogger('file-level-test');
    logger.debug('debug line', { big: 'object' });
    logger.info('info line');
    logger.warn('warn line');
    logger.error('error line');
    logFromModule('DEBUG', '[FE] client', ['client debug line']);
    logFromModule('LOG', '[FE] client', ['client info line']);
  }

  it('writes every level, DEBUG included, by default (unchanged behaviour)', async () => {
    setVerbosityLevel(VerbosityLevel.ERROR);
    writeAll();
    await flushLogger();
    const contents = fs.readFileSync(logPath, 'utf8');
    expect(contents).toContain('info line');
    expect(contents).toContain('error line');
    expect(contents).toContain('DEBUG [[SRV] file-level-test] debug line');
    expect(contents).toContain('client debug line');
    expect(console.log).not.toHaveBeenCalled();
  });

  it('VIBETUNNEL_LOG_FILE_DEBUG=0 keeps LOG/WARN/ERROR but drops DEBUG', async () => {
    vi.stubEnv('VIBETUNNEL_LOG_FILE_DEBUG', '0');
    setVerbosityLevel(VerbosityLevel.ERROR);
    writeAll();
    await flushLogger();
    const contents = fs.readFileSync(logPath, 'utf8');
    expect(contents).toContain('info line');
    expect(contents).toContain('warn line');
    expect(contents).toContain('error line');
    expect(contents).toContain('client info line');
    expect(contents).not.toContain('debug line');
  });

  it('writes DEBUG at debug verbosity even with VIBETUNNEL_LOG_FILE_DEBUG=0', async () => {
    vi.stubEnv('VIBETUNNEL_LOG_FILE_DEBUG', '0');
    setVerbosityLevel(VerbosityLevel.DEBUG);
    writeAll();
    await flushLogger();
    const contents = fs.readFileSync(logPath, 'utf8');
    expect(contents).toContain('DEBUG [[SRV] file-level-test] debug line');
    expect(contents).toContain('client debug line');
  });
});
