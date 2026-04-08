import { createMiddleware } from 'hono/factory';
import type { AuthService } from '../modules/auth/service.js';

export interface AuthContext {
  userId: string;
  practiceId: string;
  permissions: string[];
  actorType: 'human' | 'local_agent' | 'cloud_agent';
}

export function createAuthMiddleware(authService: AuthService) {
  return createMiddleware<{ Variables: { auth: AuthContext } }>(async (c, next) => {
    const apiKey = c.req.header('X-API-Key');
    if (apiKey) {
      const keyInfo = await authService.verifyAgentKey(apiKey);
      if (!keyInfo) {
        return c.json({ error: 'Invalid API key' }, 401);
      }
      c.set('auth', {
        userId: keyInfo.userId,
        practiceId: keyInfo.practiceId,
        permissions: keyInfo.scopes,
        actorType: keyInfo.modelType === 'local' ? 'local_agent' : 'cloud_agent',
      });
      return next();
    }

    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing authentication' }, 401);
    }

    const token = authHeader.slice(7);
    try {
      const payload = await authService.verifyAccessToken(token);
      c.set('auth', {
        userId: payload.userId,
        practiceId: payload.practiceId,
        permissions: payload.permissions,
        actorType: 'human',
      });
      return next();
    } catch {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }
  });
}
