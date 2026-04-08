import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { FeeScheduleService } from '../services/fee-schedule.service.js';
import type { AuthContext } from '../../../middleware/auth.js';
import {
  createFeeScheduleSchema,
  updateFeeScheduleSchema,
  feeScheduleItemSchema,
  updateFeeScheduleItemSchema,
} from '../schemas.js';

function requirePerm(permissions: string[], required: string): string | null {
  return permissions.includes(required) ? null : `${required} permission required`;
}

export function createFeeScheduleRoutes(service: FeeScheduleService) {
  const routes = new Hono<{ Variables: { auth: AuthContext } }>();

  routes.get('/', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'billing:read');
    if (err) return c.json({ error: err }, 403);

    const includeInactive = c.req.query('includeInactive') === 'true';
    const schedules = await service.list(auth.practiceId, includeInactive);
    return c.json({ feeSchedules: schedules });
  });

  routes.post('/', zValidator('json', createFeeScheduleSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'billing:submit');
    if (err) return c.json({ error: err }, 403);

    const schedule = await service.create(auth.practiceId, c.req.valid('json'));
    return c.json(schedule, 201);
  });

  routes.get('/:id', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'billing:read');
    if (err) return c.json({ error: err }, 403);

    const schedule = await service.get(auth.practiceId, c.req.param('id'));
    if (!schedule) return c.json({ error: 'Fee schedule not found' }, 404);
    return c.json(schedule);
  });

  routes.patch('/:id', zValidator('json', updateFeeScheduleSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'billing:submit');
    if (err) return c.json({ error: err }, 403);

    try {
      const schedule = await service.update(auth.practiceId, c.req.param('id'), c.req.valid('json'));
      return c.json(schedule);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      throw e;
    }
  });

  routes.delete('/:id', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'billing:submit');
    if (err) return c.json({ error: err }, 403);

    try {
      const schedule = await service.deactivate(auth.practiceId, c.req.param('id'));
      return c.json(schedule);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      throw e;
    }
  });

  // --- ITEMS ---

  routes.get('/:id/items', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'billing:read');
    if (err) return c.json({ error: err }, 403);

    // Verify ownership before exposing items
    const schedule = await service.get(auth.practiceId, c.req.param('id'));
    if (!schedule) return c.json({ error: 'Fee schedule not found' }, 404);

    const items = await service.listItems(c.req.param('id'));
    return c.json({ items });
  });

  routes.post('/:id/items', zValidator('json', feeScheduleItemSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'billing:submit');
    if (err) return c.json({ error: err }, 403);

    try {
      const item = await service.addItem(auth.practiceId, c.req.param('id'), c.req.valid('json'));
      return c.json(item, 201);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      if (msg.includes('duplicate') || msg.includes('unique')) {
        return c.json({ error: 'CPT + modifier combination already exists in this schedule' }, 409);
      }
      throw e;
    }
  });

  routes.patch('/:id/items/:itemId', zValidator('json', updateFeeScheduleItemSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'billing:submit');
    if (err) return c.json({ error: err }, 403);

    try {
      const item = await service.updateItem(
        auth.practiceId,
        c.req.param('id'),
        c.req.param('itemId'),
        c.req.valid('json'),
      );
      return c.json(item);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      throw e;
    }
  });

  routes.delete('/:id/items/:itemId', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'billing:submit');
    if (err) return c.json({ error: err }, 403);

    try {
      await service.deleteItem(auth.practiceId, c.req.param('id'), c.req.param('itemId'));
      return c.json({ success: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      throw e;
    }
  });

  return routes;
}
