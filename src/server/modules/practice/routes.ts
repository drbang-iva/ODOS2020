import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { PracticeService } from './service.js';
import type { AuthContext } from '../../middleware/auth.js';
import {
  updatePracticeSchema,
  createServiceLineSchema,
  updateServiceLineSchema,
  updateUserSchema,
  assignRoleSchema,
  createRoleSchema,
  updateRoleSchema,
} from './schemas.js';

function requirePerm(permissions: string[], required: string): string | null {
  return permissions.includes(required) ? null : `${required} permission required`;
}

export function createPracticeRoutes(service: PracticeService) {
  const routes = new Hono<{ Variables: { auth: AuthContext } }>();

  // --- PRACTICE SETTINGS ---

  routes.get('/', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:settings');
    if (err) return c.json({ error: err }, 403);

    const practice = await service.getPractice(auth.practiceId);
    if (!practice) return c.json({ error: 'Practice not found' }, 404);
    return c.json(practice);
  });

  routes.patch('/', zValidator('json', updatePracticeSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:settings');
    if (err) return c.json({ error: err }, 403);

    try {
      const practice = await service.updatePractice(auth.practiceId, c.req.valid('json'));
      return c.json(practice);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      throw e;
    }
  });

  // --- SERVICE LINES ---

  routes.get('/service-lines', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:settings');
    if (err) return c.json({ error: err }, 403);

    const includeInactive = c.req.query('includeInactive') === 'true';
    const lines = await service.listServiceLines(auth.practiceId, includeInactive);
    return c.json({ serviceLines: lines });
  });

  routes.post('/service-lines', zValidator('json', createServiceLineSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:settings');
    if (err) return c.json({ error: err }, 403);

    const sl = await service.createServiceLine(auth.practiceId, c.req.valid('json'));
    return c.json(sl, 201);
  });

  routes.patch('/service-lines/:id', zValidator('json', updateServiceLineSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:settings');
    if (err) return c.json({ error: err }, 403);

    try {
      const sl = await service.updateServiceLine(auth.practiceId, c.req.param('id'), c.req.valid('json'));
      return c.json(sl);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      throw e;
    }
  });

  routes.delete('/service-lines/:id', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:settings');
    if (err) return c.json({ error: err }, 403);

    try {
      const sl = await service.deactivateServiceLine(auth.practiceId, c.req.param('id'));
      return c.json(sl);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      throw e;
    }
  });

  // --- USER ADMIN ---

  routes.get('/users', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:users');
    if (err) return c.json({ error: err }, 403);

    const includeInactive = c.req.query('includeInactive') === 'true';
    const users = await service.listUsers(auth.practiceId, includeInactive);
    return c.json({ users });
  });

  routes.get('/users/:id', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:users');
    if (err) return c.json({ error: err }, 403);

    const user = await service.getUser(auth.practiceId, c.req.param('id'));
    if (!user) return c.json({ error: 'User not found' }, 404);
    return c.json(user);
  });

  routes.patch('/users/:id', zValidator('json', updateUserSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:users');
    if (err) return c.json({ error: err }, 403);

    try {
      const user = await service.updateUser(auth.practiceId, c.req.param('id'), c.req.valid('json'));
      return c.json(user);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      throw e;
    }
  });

  routes.get('/users/:id/roles', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:users');
    if (err) return c.json({ error: err }, 403);

    const assignments = await service.listUserRoleAssignments(c.req.param('id'));
    return c.json({ assignments });
  });

  routes.post('/users/:id/roles', zValidator('json', assignRoleSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:users');
    if (err) return c.json({ error: err }, 403);

    const { roleId, serviceLineId } = c.req.valid('json');
    try {
      const assignment = await service.assignRole(c.req.param('id'), roleId, serviceLineId ?? null);
      return c.json(assignment, 201);
    } catch (e) {
      // unique constraint violation
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('duplicate') || msg.includes('unique')) {
        return c.json({ error: 'Role already assigned to this user' }, 409);
      }
      throw e;
    }
  });

  routes.delete('/users/:id/roles/:assignmentId', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:users');
    if (err) return c.json({ error: err }, 403);

    try {
      await service.removeRoleAssignment(c.req.param('id'), c.req.param('assignmentId'));
      return c.json({ success: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      throw e;
    }
  });

  // --- ROLES ---

  routes.get('/roles', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:users');
    if (err) return c.json({ error: err }, 403);

    const roles = await service.listRoles(auth.practiceId);
    return c.json({ roles });
  });

  routes.get('/roles/:id', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:users');
    if (err) return c.json({ error: err }, 403);

    const role = await service.getRole(auth.practiceId, c.req.param('id'));
    if (!role) return c.json({ error: 'Role not found' }, 404);
    return c.json(role);
  });

  routes.post('/roles', zValidator('json', createRoleSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:users');
    if (err) return c.json({ error: err }, 403);

    const role = await service.createRole(auth.practiceId, c.req.valid('json'));
    return c.json(role, 201);
  });

  routes.patch('/roles/:id', zValidator('json', updateRoleSchema), async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:users');
    if (err) return c.json({ error: err }, 403);

    try {
      const role = await service.updateRole(auth.practiceId, c.req.param('id'), c.req.valid('json'));
      return c.json(role);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      if (msg.includes('Cannot modify')) return c.json({ error: msg }, 400);
      throw e;
    }
  });

  routes.delete('/roles/:id', async (c) => {
    const auth = c.get('auth');
    const err = requirePerm(auth.permissions, 'admin:users');
    if (err) return c.json({ error: err }, 403);

    try {
      await service.deleteRole(auth.practiceId, c.req.param('id'));
      return c.json({ success: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown';
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      if (msg.includes('Cannot delete')) return c.json({ error: msg }, 400);
      throw e;
    }
  });

  return routes;
}
