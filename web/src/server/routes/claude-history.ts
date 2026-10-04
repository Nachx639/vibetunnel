import { type Request, type Response, Router } from 'express';
import { listClaudeConversations } from '../services/claude-history.js';
import type { LiveConversation } from '../services/mac-sessions/agents.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('claude-history');

export interface ClaudeHistoryRouteOptions {
  /**
   * Why History is unavailable right now (switch off, or a --no-auth server), or null: asked on
   * every request, so the switch applies without a restart.
   */
  blocked: () => 'disabled' | 'no-auth' | null;
  claudeDir?: string;
  /**
   * Claude conversations running right now outside VibeTunnel, by conversation id. Each is marked
   * `live`: History never resumes one, which would make a second writer of it.
   */
  liveConversations?: () => Promise<Map<string, LiveConversation>>;
}

/**
 * GET /claude/conversations?query=&limit=50&offset=0 — recent Claude Code conversations, behind
 * the normal login and the `claudeHistory` switch (403 `disabled` / `no-auth` otherwise).
 */
export function createClaudeHistoryRoutes(options: ClaudeHistoryRouteOptions): Router {
  const router = Router();
  router.get('/claude/conversations', async (req: Request, res: Response) => {
    const blocked = options.blocked();
    if (blocked) {
      // Nothing is read: not the transcripts, not the process list.
      return res.status(403).json({ error: 'Claude history is off', code: blocked });
    }
    const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
    try {
      const page = await listClaudeConversations({
        query: text(req.query.query)?.slice(0, 200),
        limit: Number(text(req.query.limit) ?? 50),
        offset: Number(text(req.query.offset) ?? 0),
        claudeDir: options.claudeDir,
      });
      let live = new Map<string, LiveConversation>();
      try {
        live = (await options.liveConversations?.()) ?? live;
      } catch (error) {
        // Resuming still asks the server, which refuses a conversation live outside.
        logger.debug(`Could not tell which conversations run outside VibeTunnel: ${error}`);
      }
      res.json({
        ...page,
        conversations: page.conversations.map((conversation) => {
          const where = live.get(conversation.id);
          return where ? { ...conversation, live: where } : conversation;
        }),
      });
    } catch (error) {
      logger.error('Failed to list Claude conversations', error);
      res.status(500).json({ error: 'Failed to list Claude conversations' });
    }
  });
  return router;
}
