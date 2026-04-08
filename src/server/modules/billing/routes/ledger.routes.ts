import { Hono } from 'hono';
import type { LedgerService } from '../services/ledger.service.js';
import type { AuthContext } from '../../../middleware/auth.js';

function requirePerm(permissions: string[], required: string): string | null {
  return permissions.includes(required) ? null : `${required} permission required`;
}

export function createLedgerRoutes(service: LedgerService) {
  const routes = new Hono<{ Variables: { auth: AuthContext } }>();

  // GET /patient/:patientId — running balance summary
  routes.get('/patient/:patientId', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'billing:read');
    if (err) return c.json({ error: err }, 403);

    const ledger = await service.getPatientLedger(auth.practiceId, c.req.param('patientId'));
    if (!ledger) return c.json({ error: 'Patient not found' }, 404);
    return c.json(ledger);
  });

  // GET /patient/:patientId/charges — per-charge breakdown
  routes.get('/patient/:patientId/charges', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'billing:read');
    if (err) return c.json({ error: err }, 403);

    const charges = await service.getPatientChargeDetails(auth.practiceId, c.req.param('patientId'));
    return c.json({ charges });
  });

  return routes;
}
