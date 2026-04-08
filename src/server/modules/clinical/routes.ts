import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { ClinicalEncounterService } from './service.js';
import type { AuthContext } from '../../middleware/auth.js';
import type { ActorContext } from '../../events/builder.js';
import { createEncounterSchema, listEncountersSchema } from './schemas.js';

function requirePerm(permissions: string[], required: string): string | null {
  return permissions.includes(required) ? null : `${required} permission required`;
}

function actorFrom(auth: AuthContext): ActorContext {
  return {
    userId: auth.userId,
    practiceId: auth.practiceId,
    actorType: auth.actorType,
  };
}

export function createClinicalRoutes(service: ClinicalEncounterService) {
  const routes = new Hono<{ Variables: { auth: AuthContext } }>();

  // GET /encounters — list with filters
  routes.get('/encounters', zValidator('query', listEncountersSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'clinical:read');
    if (err) return c.json({ error: err }, 403);

    const result = await service.list(auth.practiceId, c.req.valid('query'));
    return c.json(result);
  });

  // POST /encounters — create a new draft encounter
  routes.post('/encounters', zValidator('json', createEncounterSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'clinical:write');
    if (err) return c.json({ error: err }, 403);

    try {
      const encounter = await service.create(
        auth.practiceId,
        c.req.valid('json'),
        actorFrom(auth),
      );
      return c.json(encounter, 201);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found') || msg.includes('does not match')) {
        return c.json({ error: msg }, 404);
      }
      throw e;
    }
  });

  // GET /encounters/:id — read one encounter
  routes.get('/encounters/:id', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'clinical:read');
    if (err) return c.json({ error: err }, 403);

    const encounter = await service.get(auth.practiceId, c.req.param('id'));
    if (!encounter) return c.json({ error: 'Encounter not found' }, 404);
    return c.json(encounter);
  });

  // POST /encounters/:id/sign — sign the encounter, locking it for billing
  routes.post('/encounters/:id/sign', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'clinical:write');
    if (err) return c.json({ error: err }, 403);

    try {
      const encounter = await service.sign(
        auth.practiceId,
        c.req.param('id'),
        actorFrom(auth),
      );
      return c.json(encounter);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      if (msg.includes('already signed')) return c.json({ error: msg }, 400);
      throw e;
    }
  });

  return routes;
}
