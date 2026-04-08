import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { PaymentService } from '../services/payment.service.js';
import type { AuthContext } from '../../../middleware/auth.js';
import {
  createPaymentSchema,
  applyPaymentSchema,
  voidPaymentSchema,
  listPaymentsSchema,
} from '../schemas.js';

function requirePerm(permissions: string[], required: string): string | null {
  return permissions.includes(required) ? null : `${required} permission required`;
}

export function createPaymentRoutes(service: PaymentService) {
  const routes = new Hono<{ Variables: { auth: AuthContext } }>();

  routes.get('/', zValidator('query', listPaymentsSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'billing:read');
    if (err) return c.json({ error: err }, 403);

    const result = await service.list(auth.practiceId, c.req.valid('query'));
    return c.json(result);
  });

  routes.post('/', zValidator('json', createPaymentSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'billing:submit');
    if (err) return c.json({ error: err }, 403);

    try {
      const result = await service.create(auth.practiceId, auth.userId, c.req.valid('json'));
      return c.json(result, 201);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      if (msg.includes('exceeds') || msg.includes('require') || msg.includes('voided')) {
        return c.json({ error: msg }, 400);
      }
      throw e;
    }
  });

  routes.get('/:id', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'billing:read');
    if (err) return c.json({ error: err }, 403);

    const payment = await service.get(auth.practiceId, c.req.param('id'));
    if (!payment) return c.json({ error: 'Payment not found' }, 404);
    return c.json(payment);
  });

  routes.get('/:id/applications', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'billing:read');
    if (err) return c.json({ error: err }, 403);

    // Verify ownership
    const payment = await service.get(auth.practiceId, c.req.param('id'));
    if (!payment) return c.json({ error: 'Payment not found' }, 404);

    const applications = await service.listApplications(c.req.param('id'));
    return c.json({ applications });
  });

  routes.post('/:id/apply', zValidator('json', applyPaymentSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'billing:submit');
    if (err) return c.json({ error: err }, 403);

    try {
      const application = await service.applyToCharge(
        auth.practiceId,
        c.req.param('id'),
        auth.userId,
        c.req.valid('json'),
      );
      return c.json(application, 201);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      if (msg.includes('exceeds') || msg.includes('voided')) {
        return c.json({ error: msg }, 400);
      }
      throw e;
    }
  });

  routes.post('/:id/void', zValidator('json', voidPaymentSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'billing:void');
    if (err) return c.json({ error: err }, 403);

    const { reason } = c.req.valid('json');
    try {
      const payment = await service.voidPayment(auth.practiceId, c.req.param('id'), auth.userId, reason);
      return c.json(payment);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      if (msg.includes('already voided')) return c.json({ error: msg }, 400);
      throw e;
    }
  });

  return routes;
}
