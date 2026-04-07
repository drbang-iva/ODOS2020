import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AuthService } from './service.js';
import { loginSchema, refreshSchema, createUserSchema, createAgentKeySchema } from './schemas.js';
import type { AuthContext } from '../../middleware/auth.js';

export function createAuthRoutes(authService: AuthService) {
  const routes = new Hono<{ Variables: { auth: AuthContext } }>();

  // Public: login
  routes.post('/login', zValidator('json', loginSchema), async (c) => {
    const input = c.req.valid('json');
    try {
      const tokens = await authService.login(input);
      return c.json(tokens);
    } catch {
      return c.json({ error: 'Invalid credentials' }, 401);
    }
  });

  // Public: refresh
  routes.post('/refresh', zValidator('json', refreshSchema), async (c) => {
    const { refreshToken } = c.req.valid('json');
    try {
      const tokens = await authService.refreshAccessToken(refreshToken);
      return c.json(tokens);
    } catch {
      return c.json({ error: 'Invalid or expired refresh token' }, 401);
    }
  });

  // Protected: create user (admin only)
  routes.post('/users', zValidator('json', createUserSchema), async (c) => {
    const auth = c.get('auth');
    if (auth.role !== 'admin') {
      return c.json({ error: 'Admin role required' }, 403);
    }
    const input = c.req.valid('json');
    const user = await authService.createUser(auth.practiceId, input);
    return c.json(user, 201);
  });

  // Protected: create agent key (admin only)
  routes.post('/agent-keys', zValidator('json', createAgentKeySchema), async (c) => {
    const auth = c.get('auth');
    if (auth.role !== 'admin') {
      return c.json({ error: 'Admin role required' }, 403);
    }
    const input = c.req.valid('json');
    // Create an agent user identity
    const agentUser = await authService.createUser(auth.practiceId, {
      email: `${input.name}@agent.local`,
      password: crypto.randomUUID(),
      fullName: input.name,
      role: 'agent',
      isProvider: false,
      serviceLineIds: [],
    });
    const result = await authService.createAgentKey(auth.practiceId, agentUser.id, input);
    return c.json({ keyId: result.keyId, rawKey: result.rawKey, agentUserId: agentUser.id }, 201);
  });

  return routes;
}
