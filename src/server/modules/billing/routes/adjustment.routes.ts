import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AdjustmentService } from '../services/adjustment.service.js';
import type { AuthContext } from '../../../middleware/auth.js';
import { createAdjustmentSchema } from '../schemas.js';

function requirePerm(permissions: string[], required: string): string | null {
  return permissions.includes(required) ? null : `${required} permission required`;
}

export function createAdjustmentRoutes(service: AdjustmentService) {
  const routes = new Hono<{ Variables: { auth: AuthContext } }>();

  routes.post('/', zValidator('json', createAdjustmentSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'billing:submit');
    if (err) return c.json({ error: err }, 403);

    try {
      const adjustment = await service.create(auth.practiceId, auth.userId, c.req.valid('json'));
      return c.json(adjustment, 201);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      if (msg.includes('voided')) return c.json({ error: msg }, 400);
      throw e;
    }
  });

  routes.get('/charge/:chargeId', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'billing:read');
    if (err) return c.json({ error: err }, 403);

    try {
      const adjustments = await service.listForCharge(auth.practiceId, c.req.param('chargeId'));
      return c.json({ adjustments });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      throw e;
    }
  });

  routes.get('/:id', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'billing:read');
    if (err) return c.json({ error: err }, 403);

    const adjustment = await service.get(auth.practiceId, c.req.param('id'));
    if (!adjustment) return c.json({ error: 'Adjustment not found' }, 404);
    return c.json(adjustment);
  });

  routes.delete('/:id', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'billing:void');
    if (err) return c.json({ error: err }, 403);

    try {
      await service.delete(auth.practiceId, c.req.param('id'));
      return c.json({ success: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      throw e;
    }
  });

  return routes;
}
