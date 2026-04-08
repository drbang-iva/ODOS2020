import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { ChargeService } from '../services/charge.service.js';
import type { AuthContext } from '../../../middleware/auth.js';
import {
  createChargeSchema,
  updateChargeSchema,
  voidChargeSchema,
  listChargesSchema,
} from '../schemas.js';

function requirePerm(permissions: string[], required: string): string | null {
  return permissions.includes(required) ? null : `${required} permission required`;
}

export function createChargeRoutes(service: ChargeService) {
  const routes = new Hono<{ Variables: { auth: AuthContext } }>();

  routes.get('/', zValidator('query', listChargesSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'billing:read');
    if (err) return c.json({ error: err }, 403);

    const result = await service.list(auth.practiceId, c.req.valid('query'));
    return c.json(result);
  });

  routes.post('/', zValidator('json', createChargeSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'billing:submit');
    if (err) return c.json({ error: err }, 403);

    try {
      const charge = await service.create(auth.practiceId, auth.userId, c.req.valid('json'));
      return c.json(charge, 201);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('No price') || msg.includes('Price not found')) {
        return c.json({ error: msg }, 400);
      }
      throw e;
    }
  });

  routes.get('/:id', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'billing:read');
    if (err) return c.json({ error: err }, 403);

    const charge = await service.get(auth.practiceId, c.req.param('id'));
    if (!charge) return c.json({ error: 'Charge not found' }, 404);
    return c.json(charge);
  });

  routes.patch('/:id', zValidator('json', updateChargeSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'billing:submit');
    if (err) return c.json({ error: err }, 403);

    try {
      const charge = await service.update(auth.practiceId, c.req.param('id'), c.req.valid('json'));
      return c.json(charge);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      if (msg.includes('Cannot update')) return c.json({ error: msg }, 400);
      throw e;
    }
  });

  routes.post('/:id/void', zValidator('json', voidChargeSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'billing:void');
    if (err) return c.json({ error: err }, 403);

    const { reason } = c.req.valid('json');
    try {
      const charge = await service.voidCharge(auth.practiceId, c.req.param('id'), auth.userId, reason);
      return c.json(charge);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      if (msg.includes('already voided')) return c.json({ error: msg }, 400);
      throw e;
    }
  });

  routes.get('/:id/balance', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'billing:read');
    if (err) return c.json({ error: err }, 403);

    // Verify charge belongs to practice
    const charge = await service.get(auth.practiceId, c.req.param('id'));
    if (!charge) return c.json({ error: 'Charge not found' }, 404);

    const balance = await service.getUnpaidBalance(c.req.param('id'));
    return c.json({ chargeId: c.req.param('id'), unpaidBalanceCents: balance });
  });

  return routes;
}
