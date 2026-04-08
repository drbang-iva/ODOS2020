import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AuditService } from './service.js';
import type { AuthContext } from '../../middleware/auth.js';
import { searchAuditSchema } from './schemas.js';

function requirePerm(permissions: string[], required: string): string | null {
  return permissions.includes(required) ? null : `${required} permission required`;
}

export function createAuditRoutes(service: AuditService) {
  const routes = new Hono<{ Variables: { auth: AuthContext } }>();

  // GET / — search events with filters + pagination
  routes.get('/', zValidator('query', searchAuditSchema), async (c) => {
    const auth = c.get('auth');
    // Audit access is gated on reports:read (compliance queries). Can swap to
    // a dedicated 'audit:read' permission later if needed.
    const err = requirePerm(auth.permissions, 'reports:read');
    if (err) return c.json({ error: err }, 403);

    const result = await service.search(auth.practiceId, c.req.valid('query'));
    return c.json(result);
  });

  // GET /entity/:entityType/:entityId — full history for a specific entity
  routes.get('/entity/:entityType/:entityId', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'reports:read');
    if (err) return c.json({ error: err }, 403);

    const events = await service.getEntityHistory(
      auth.practiceId,
      c.req.param('entityType'),
      c.req.param('entityId'),
    );
    return c.json({ events });
  });

  return routes;
}
