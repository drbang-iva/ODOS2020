import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { CatalogService } from './service.js';
import type { AuthContext } from '../../middleware/auth.js';
import {
  createLibraryItemSchema,
  updateLibraryItemSchema,
  createBodyAreaSchema,
  updateBodyAreaSchema,
  createAppointmentTypeSchema,
  updateAppointmentTypeSchema,
  cloneFromLibrarySchema,
} from './schemas.js';

function requirePerm(permissions: string[], required: string): string | null {
  return permissions.includes(required) ? null : `${required} permission required`;
}

export function createCatalogRoutes(service: CatalogService) {
  const routes = new Hono<{ Variables: { auth: AuthContext } }>();

  // --- TREATMENT LIBRARY ---
  // Read is open to anyone with admin:settings; write requires admin:settings (system-shipped catalog)

  routes.get('/library', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:settings');
    if (err) return c.json({ error: err }, 403);

    const category = c.req.query('category');
    const serviceLine = c.req.query('serviceLine');
    const items = await service.listLibrary({ category, serviceLine });
    return c.json({ items });
  });

  routes.get('/library/:id', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:settings');
    if (err) return c.json({ error: err }, 403);

    const item = await service.getLibraryItem(c.req.param('id'));
    if (!item) return c.json({ error: 'Library item not found' }, 404);
    return c.json(item);
  });

  routes.post('/library', zValidator('json', createLibraryItemSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:settings');
    if (err) return c.json({ error: err }, 403);

    const item = await service.createLibraryItem(c.req.valid('json'));
    return c.json(item, 201);
  });

  routes.patch('/library/:id', zValidator('json', updateLibraryItemSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:settings');
    if (err) return c.json({ error: err }, 403);

    try {
      const item = await service.updateLibraryItem(c.req.param('id'), c.req.valid('json'));
      return c.json(item);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      throw e;
    }
  });

  routes.delete('/library/:id', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:settings');
    if (err) return c.json({ error: err }, 403);

    try {
      await service.deleteLibraryItem(c.req.param('id'));
      return c.json({ success: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      throw e;
    }
  });

  // --- BODY AREA MODIFIERS ---

  routes.get('/body-areas', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:settings');
    if (err) return c.json({ error: err }, 403);

    const items = await service.listBodyAreas(auth.practiceId);
    return c.json({ bodyAreas: items });
  });

  routes.post('/body-areas', zValidator('json', createBodyAreaSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:settings');
    if (err) return c.json({ error: err }, 403);

    const item = await service.createBodyArea(auth.practiceId, c.req.valid('json'));
    return c.json(item, 201);
  });

  routes.patch('/body-areas/:id', zValidator('json', updateBodyAreaSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:settings');
    if (err) return c.json({ error: err }, 403);

    try {
      const item = await service.updateBodyArea(auth.practiceId, c.req.param('id'), c.req.valid('json'));
      return c.json(item);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      if (msg.includes('Cannot modify')) return c.json({ error: msg }, 400);
      throw e;
    }
  });

  routes.delete('/body-areas/:id', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:settings');
    if (err) return c.json({ error: err }, 403);

    try {
      await service.deleteBodyArea(auth.practiceId, c.req.param('id'));
      return c.json({ success: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      if (msg.includes('Cannot delete')) return c.json({ error: msg }, 400);
      throw e;
    }
  });

  // --- APPOINTMENT TYPES ---

  routes.get('/appointment-types', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:settings');
    if (err) return c.json({ error: err }, 403);

    const includeInactive = c.req.query('includeInactive') === 'true';
    const items = await service.listAppointmentTypes(auth.practiceId, includeInactive);
    return c.json({ appointmentTypes: items });
  });

  routes.get('/appointment-types/:id', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:settings');
    if (err) return c.json({ error: err }, 403);

    const item = await service.getAppointmentType(auth.practiceId, c.req.param('id'));
    if (!item) return c.json({ error: 'Appointment type not found' }, 404);
    return c.json(item);
  });

  routes.post('/appointment-types', zValidator('json', createAppointmentTypeSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:settings');
    if (err) return c.json({ error: err }, 403);

    const item = await service.createAppointmentType(auth.practiceId, c.req.valid('json'));
    return c.json(item, 201);
  });

  routes.post('/appointment-types/from-library', zValidator('json', cloneFromLibrarySchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:settings');
    if (err) return c.json({ error: err }, 403);

    try {
      const item = await service.cloneFromLibrary(auth.practiceId, c.req.valid('json'));
      return c.json(item, 201);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      throw e;
    }
  });

  routes.patch('/appointment-types/:id', zValidator('json', updateAppointmentTypeSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:settings');
    if (err) return c.json({ error: err }, 403);

    try {
      const item = await service.updateAppointmentType(auth.practiceId, c.req.param('id'), c.req.valid('json'));
      return c.json(item);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      throw e;
    }
  });

  routes.delete('/appointment-types/:id', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:settings');
    if (err) return c.json({ error: err }, 403);

    try {
      const item = await service.deactivateAppointmentType(auth.practiceId, c.req.param('id'));
      return c.json(item);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      throw e;
    }
  });

  return routes;
}
