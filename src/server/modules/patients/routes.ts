import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { PatientService } from './service.js';
import type { AuthContext } from '../../middleware/auth.js';
import {
  createPatientSchema,
  updatePatientSchema,
  searchPatientsSchema,
  createInsuranceSchema,
  updateInsuranceSchema,
  createResponsiblePartySchema,
  createAlertSchema,
} from './schemas.js';

function requirePermission(permissions: string[], required: string): string | null {
  return permissions.includes(required) ? null : `${required} permission required`;
}

export function createPatientRoutes(service: PatientService) {
  const routes = new Hono<{ Variables: { auth: AuthContext } }>();

  // --- PATIENT CRUD ---

  // GET /?q=&name=&phone=&dob=&limit=&offset=
  routes.get('/', zValidator('query', searchPatientsSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePermission(auth.permissions, 'patients:read');
    if (err) return c.json({ error: err }, 403);

    const input = c.req.valid('query');
    const result = await service.search(auth.practiceId, input);
    return c.json(result);
  });

  // POST /
  routes.post('/', zValidator('json', createPatientSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePermission(auth.permissions, 'patients:write');
    if (err) return c.json({ error: err }, 403);

    const input = c.req.valid('json');
    const patient = await service.create(auth.practiceId, input);
    return c.json(patient, 201);
  });

  // GET /:id
  routes.get('/:id', async (c) => {
    const auth = c.get('auth');
    const err = requirePermission(auth.permissions, 'patients:read');
    if (err) return c.json({ error: err }, 403);

    const patient = await service.get(auth.practiceId, c.req.param('id'));
    if (!patient) return c.json({ error: 'Patient not found' }, 404);
    return c.json(patient);
  });

  // PATCH /:id
  routes.patch('/:id', zValidator('json', updatePatientSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePermission(auth.permissions, 'patients:write');
    if (err) return c.json({ error: err }, 403);

    const input = c.req.valid('json');
    try {
      const patient = await service.update(auth.practiceId, c.req.param('id'), input);
      return c.json(patient);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      throw e;
    }
  });

  // DELETE /:id (soft delete = deactivate)
  routes.delete('/:id', async (c) => {
    const auth = c.get('auth');
    const err = requirePermission(auth.permissions, 'patients:delete');
    if (err) return c.json({ error: err }, 403);

    try {
      const patient = await service.deactivate(auth.practiceId, c.req.param('id'));
      return c.json(patient);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      throw e;
    }
  });

  // --- INSURANCE ---

  // GET /:id/insurance
  routes.get('/:id/insurance', async (c) => {
    const auth = c.get('auth');
    const err = requirePermission(auth.permissions, 'patients:read');
    if (err) return c.json({ error: err }, 403);

    const insurance = await service.listInsurance(c.req.param('id'));
    return c.json({ insurance });
  });

  // POST /:id/insurance
  routes.post('/:id/insurance', zValidator('json', createInsuranceSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePermission(auth.permissions, 'patients:write');
    if (err) return c.json({ error: err }, 403);

    const input = c.req.valid('json');
    const insurance = await service.addInsurance(c.req.param('id'), input);
    return c.json(insurance, 201);
  });

  // PATCH /:id/insurance/:insId
  routes.patch('/:id/insurance/:insId', zValidator('json', updateInsuranceSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePermission(auth.permissions, 'patients:write');
    if (err) return c.json({ error: err }, 403);

    const input = c.req.valid('json');
    try {
      const insurance = await service.updateInsurance(c.req.param('id'), c.req.param('insId'), input);
      return c.json(insurance);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      throw e;
    }
  });

  // DELETE /:id/insurance/:insId
  routes.delete('/:id/insurance/:insId', async (c) => {
    const auth = c.get('auth');
    const err = requirePermission(auth.permissions, 'patients:write');
    if (err) return c.json({ error: err }, 403);

    try {
      await service.deleteInsurance(c.req.param('id'), c.req.param('insId'));
      return c.json({ success: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      throw e;
    }
  });

  // --- RESPONSIBLE PARTIES ---

  // GET /:id/responsible-parties
  routes.get('/:id/responsible-parties', async (c) => {
    const auth = c.get('auth');
    const err = requirePermission(auth.permissions, 'patients:read');
    if (err) return c.json({ error: err }, 403);

    const parties = await service.listResponsibleParties(c.req.param('id'));
    return c.json({ responsibleParties: parties });
  });

  // POST /:id/responsible-parties
  routes.post('/:id/responsible-parties', zValidator('json', createResponsiblePartySchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePermission(auth.permissions, 'patients:write');
    if (err) return c.json({ error: err }, 403);

    const input = c.req.valid('json');
    const rp = await service.addResponsibleParty(c.req.param('id'), input);
    return c.json(rp, 201);
  });

  // DELETE /:id/responsible-parties/:rpId
  routes.delete('/:id/responsible-parties/:rpId', async (c) => {
    const auth = c.get('auth');
    const err = requirePermission(auth.permissions, 'patients:write');
    if (err) return c.json({ error: err }, 403);

    try {
      await service.deleteResponsibleParty(c.req.param('id'), c.req.param('rpId'));
      return c.json({ success: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      throw e;
    }
  });

  // --- ALERTS ---

  // GET /:id/alerts?includeResolved=true
  routes.get('/:id/alerts', async (c) => {
    const auth = c.get('auth');
    const err = requirePermission(auth.permissions, 'patients:read');
    if (err) return c.json({ error: err }, 403);

    const includeResolved = c.req.query('includeResolved') === 'true';
    const alerts = await service.listAlerts(c.req.param('id'), includeResolved);
    return c.json({ alerts });
  });

  // POST /:id/alerts
  routes.post('/:id/alerts', zValidator('json', createAlertSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePermission(auth.permissions, 'patients:write');
    if (err) return c.json({ error: err }, 403);

    const input = c.req.valid('json');
    const alert = await service.addAlert(c.req.param('id'), auth.userId, input);
    return c.json(alert, 201);
  });

  // POST /:id/alerts/:alertId/resolve
  routes.post('/:id/alerts/:alertId/resolve', async (c) => {
    const auth = c.get('auth');
    const err = requirePermission(auth.permissions, 'patients:write');
    if (err) return c.json({ error: err }, 403);

    try {
      const alert = await service.resolveAlert(
        c.req.param('id'),
        c.req.param('alertId'),
        auth.userId,
      );
      return c.json(alert);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      throw e;
    }
  });

  return routes;
}
