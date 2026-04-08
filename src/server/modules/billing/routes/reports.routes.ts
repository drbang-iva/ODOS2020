import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { ReportsService } from '../services/reports.service.js';
import type { AuthContext } from '../../../middleware/auth.js';
import { arAgingDetailsQuerySchema } from '../schemas.js';

function requirePerm(permissions: string[], required: string): string | null {
  return permissions.includes(required) ? null : `${required} permission required`;
}

export function createReportsRoutes(service: ReportsService) {
  const routes = new Hono<{ Variables: { auth: AuthContext } }>();

  // GET /ar-aging — summary: totals per bucket, plus grand totals
  routes.get('/ar-aging', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'reports:read');
    if (err) return c.json({ error: err }, 403);

    const summary = await service.arAgingSummary(auth.practiceId);
    return c.json(summary);
  });

  // GET /ar-aging/details?bucket=61-90&limit=100&offset=0
  // Drill-down per-charge view for the AR aging report.
  routes.get(
    '/ar-aging/details',
    zValidator('query', arAgingDetailsQuerySchema),
    async (c) => {
      const auth = c.get('auth');
      const err = requirePerm(auth.permissions, 'reports:read');
      if (err) return c.json({ error: err }, 403);

      const result = await service.arAgingDetails(auth.practiceId, c.req.valid('query'));
      return c.json(result);
    },
  );

  return routes;
}
