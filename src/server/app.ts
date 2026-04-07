import { Hono } from 'hono';
import type pg from 'pg';
import type { Config } from './config/index.js';
import { InProcessEventBus } from './events/bus.js';
import { createAuditHandler } from './events/handlers/audit.handler.js';
import { createCorsMiddleware } from './middleware/cors.js';
import { RateLimiter } from './middleware/rate-limit.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createAuditMiddleware } from './middleware/audit.js';
import { AuthService } from './modules/auth/service.js';
import { createAuthRoutes } from './modules/auth/routes.js';

export interface AppDependencies {
  pool: pg.Pool;
  config: Config;
}

export function createApp({ pool, config }: AppDependencies) {
  const app = new Hono();

  // Services
  const eventBus = new InProcessEventBus();
  const authService = new AuthService(pool, config.jwtSecret);

  // Event subscriptions
  const auditHandler = createAuditHandler(pool);
  eventBus.on('*', auditHandler);

  // Rate limiters
  const humanLimiter = new RateLimiter({
    windowMs: config.rateLimitWindowMs,
    maxRequests: config.rateLimitMaxRequests,
  });
  const agentLimiter = new RateLimiter({
    windowMs: config.rateLimitWindowMs,
    maxRequests: config.rateLimitAgentMaxRequests,
  });

  // Global middleware
  app.use('*', createCorsMiddleware());

  // Rate limiting (before auth so we can limit by IP)
  app.use('/api/*', async (c, next) => {
    const clientId = c.req.header('x-forwarded-for') ?? 'localhost';
    const isAgent = !!c.req.header('X-API-Key');
    const limiter = isAgent ? agentLimiter : humanLimiter;
    const result = limiter.check(clientId);
    if (!result.allowed) {
      return c.json(
        { error: 'Rate limit exceeded', retryAfterMs: result.retryAfterMs },
        429,
      );
    }
    return next();
  });

  // Health check (no auth required)
  app.get('/health', (c) => c.json({ status: 'ok', version: '0.1.0' }));

  // Auth middleware for protected auth sub-routes (users, agent-keys) —
  // must be registered before app.route() so middleware runs for those paths.
  // Login and refresh are public; POST /users and POST /agent-keys require admin auth.
  const authMiddleware = createAuthMiddleware(authService);
  app.use('/api/auth/users', authMiddleware);
  app.use('/api/auth/agent-keys', authMiddleware);

  // Auth routes (login/refresh are public, users/agent-keys are protected above)
  const authRoutes = createAuthRoutes(authService);
  app.route('/api/auth', authRoutes);

  // Protected API routes (auth required)
  app.use('/api/patients/*', authMiddleware);
  app.use('/api/schedule/*', authMiddleware);
  app.use('/api/appointments/*', authMiddleware);
  app.use('/api/practice/*', authMiddleware);
  app.use('/api/service-lines/*', authMiddleware);
  app.use('/api/agent/*', authMiddleware);

  // Audit middleware for PHI endpoints
  app.use('/api/patients/*', createAuditMiddleware(pool));
  app.use('/api/appointments/*', createAuditMiddleware(pool));

  // Placeholder routes (modules added in subsequent plans)
  app.get('/api/patients', (c) => c.json({ message: 'Patients module coming next' }));
  app.get('/api/schedule/grid', (c) => c.json({ message: 'Schedule module coming next' }));

  return { app, eventBus, authService };
}
