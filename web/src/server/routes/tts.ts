/**
 * Read-aloud for the chat and voice mode, behind the same `"voice": true` switch as dictation.
 *
 * GET /api/tts/status → { enabled, available, engine, engines, ready, maxChars }. Off, it says
 * `enabled: false` without looking for any engine. `?warm=1&lang=xx` loads Kokoro (when it is
 * the engine) and warms it for that language, so the first reply doesn't wait for the model.
 * POST /api/tts { text, lang? } → WAV audio of `text`. Off: 403 before the body is read.
 * Mounted behind the /api auth middleware like every other route.
 */
import express, { type NextFunction, type Request, type Response, Router } from 'express';
import { MAX_TTS_CHARS, normalizeSpeechLanguage } from '../../shared/tts-text.js';
import type { ConfigService } from '../services/config-service.js';
import {
  availableEngines,
  residentKokoro,
  stopResidentKokoro,
  synthesize,
  TtsBusyError,
} from '../services/tts.js';
import { createLogger } from '../utils/logger.js';
import { voiceEnabled } from './dictation.js';

const logger = createLogger('tts');

export interface TtsRouteOptions {
  configService: Pick<ConfigService, 'getConfig'>;
}

export function createTtsRoutes(options: TtsRouteOptions): Router {
  const router = Router();
  const { configService } = options;

  router.get('/tts/status', (req: Request, res: Response) => {
    if (!voiceEnabled(configService)) {
      stopResidentKokoro();
      res.json({
        enabled: false,
        available: false,
        engine: null,
        engines: [],
        ready: false,
        maxChars: MAX_TTS_CHARS,
      });
      return;
    }
    const engines = availableEngines();
    const kokoro = engines[0] === 'kokoro' ? residentKokoro() : null;
    const lang = normalizeSpeechLanguage(req.query.lang) ?? 'en';
    if (kokoro && req.query.warm === '1') void kokoro.warm(lang).catch(() => undefined);
    res.json({
      enabled: true,
      available: engines.length > 0,
      engine: engines[0] ?? null,
      engines,
      ready: engines[0] === 'kokoro' ? Boolean(kokoro?.readyFor(lang)) : engines.length > 0,
      maxChars: MAX_TTS_CHARS,
    });
  });

  // Refuse before the body is parsed: with voice off nothing is read or started.
  const requireVoice = (_req: Request, res: Response, next: NextFunction) => {
    if (!voiceEnabled(configService)) {
      stopResidentKokoro();
      res.status(403).json({ error: 'disabled' });
      return;
    }
    next();
  };

  router.post(
    '/tts',
    requireVoice,
    express.json({ limit: '16kb' }),
    async (req: Request, res: Response) => {
      const { text, lang } = (req.body ?? {}) as { text?: unknown; lang?: unknown };
      if (typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'No text to read' });
      }
      if (text.length > MAX_TTS_CHARS) {
        return res.status(413).json({ error: `At most ${MAX_TTS_CHARS} characters per request` });
      }
      if (availableEngines().length === 0) {
        return res.status(503).json({ error: 'No text-to-speech engine on this server' });
      }
      const abort = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) abort.abort();
      });
      const started = Date.now();
      try {
        const speech = await synthesize(text, lang, abort.signal);
        logger.log(
          `${speech.engine} (${speech.lang}) read ${text.length} chars in ${Date.now() - started} ms`
        );
        res.set({
          'Content-Type': speech.contentType,
          'Cache-Control': 'no-store',
          'X-TTS-Engine': speech.engine,
          'X-TTS-Lang': speech.lang,
        });
        res.send(speech.audio);
      } catch (error) {
        if (error instanceof TtsBusyError) {
          return res.status(429).json({ error: 'Busy reading, try again in a moment' });
        }
        if (abort.signal.aborted) return;
        logger.error('speech failed:', error);
        res.status(500).json({ error: 'Speech failed' });
      }
    }
  );

  // express.json's limit error (413) as JSON, like the rest of the API.
  router.use(
    '/tts',
    (error: Error & { type?: string }, _req: Request, res: Response, next: NextFunction) => {
      if (error?.type === 'entity.too.large') {
        res.status(413).json({ error: 'Text too large' });
        return;
      }
      next(error);
    }
  );

  return router;
}
