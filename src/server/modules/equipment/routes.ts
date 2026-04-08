import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { EquipmentService } from './service.js';
import type { AuthContext } from '../../middleware/auth.js';
import type { ActorContext } from '../../events/builder.js';
import {
  createEquipmentSchema,
  updateEquipmentSchema,
  listEquipmentSchema,
  createReadingSchema,
  listReadingsSchema,
  reviewReadingSchema,
} from './schemas.js';

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

export function createEquipmentRoutes(service: EquipmentService) {
  const routes = new Hono<{ Variables: { auth: AuthContext } }>();

  // --- DEVICE READINGS ---
  // Register these BEFORE /:id routes so `/readings` doesn't match the param route.

  routes.get('/readings', zValidator('query', listReadingsSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'clinical:read');
    if (err) return c.json({ error: err }, 403);

    const result = await service.listReadings(auth.practiceId, c.req.valid('query'));
    return c.json(result);
  });

  routes.post('/readings', zValidator('json', createReadingSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'clinical:write');
    if (err) return c.json({ error: err }, 403);

    try {
      const reading = await service.createReading(auth.practiceId, c.req.valid('json'), actorFrom(auth));
      return c.json(reading, 201);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      throw e;
    }
  });

  routes.get('/readings/:id', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'clinical:read');
    if (err) return c.json({ error: err }, 403);

    const reading = await service.getReading(auth.practiceId, c.req.param('id'));
    if (!reading) return c.json({ error: 'Reading not found' }, 404);
    return c.json(reading);
  });

  routes.post('/readings/:id/review', zValidator('json', reviewReadingSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'clinical:write');
    if (err) return c.json({ error: err }, 403);

    try {
      const reading = await service.reviewReading(
        auth.practiceId,
        c.req.param('id'),
        c.req.valid('json'),
        actorFrom(auth),
      );
      return c.json(reading);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      throw e;
    }
  });

  // --- EQUIPMENT REGISTRY ---

  routes.get('/', zValidator('query', listEquipmentSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:settings');
    if (err) return c.json({ error: err }, 403);

    const items = await service.list(auth.practiceId, c.req.valid('query'));
    return c.json({ equipment: items });
  });

  routes.post('/', zValidator('json', createEquipmentSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:settings');
    if (err) return c.json({ error: err }, 403);

    const item = await service.create(auth.practiceId, c.req.valid('json'), actorFrom(auth));
    return c.json(item, 201);
  });

  routes.get('/:id', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:settings');
    if (err) return c.json({ error: err }, 403);

    const item = await service.get(auth.practiceId, c.req.param('id'));
    if (!item) return c.json({ error: 'Equipment not found' }, 404);
    return c.json(item);
  });

  routes.patch('/:id', zValidator('json', updateEquipmentSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:settings');
    if (err) return c.json({ error: err }, 403);

    try {
      const item = await service.update(auth.practiceId, c.req.param('id'), c.req.valid('json'), actorFrom(auth));
      return c.json(item);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      throw e;
    }
  });

  routes.delete('/:id', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:settings');
    if (err) return c.json({ error: err }, 403);

    try {
      const item = await service.deactivate(auth.practiceId, c.req.param('id'), actorFrom(auth));
      return c.json(item);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      throw e;
    }
  });

  return routes;
}
