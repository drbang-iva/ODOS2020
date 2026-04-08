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
import { ScheduleService } from './modules/schedule/service.js';
import { createScheduleRoutes } from './modules/schedule/routes.js';
import { PatientService } from './modules/patients/service.js';
import { createPatientRoutes } from './modules/patients/routes.js';

export interface AppDependencies {
  pool: pg.Pool;
  config: Config;
}

export function createApp({ pool, config }: AppDependencies) {
  const app = new Hono();

  // Services
  const eventBus = new InProcessEventBus();
  const authService = new AuthService(pool, config.jwtSecret);
  const scheduleService = new ScheduleService(pool);
  const patientService = new PatientService(pool);

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

  // Auth middleware — MUST be registered before app.route() calls so it runs for sub-routes.
  // Login and refresh under /api/auth are public; /api/auth/users and /api/auth/agent-keys require admin.
  const authMiddleware = createAuthMiddleware(authService);
  app.use('/api/auth/users', authMiddleware);
  app.use('/api/auth/agent-keys', authMiddleware);
  app.use('/api/patients/*', authMiddleware);
  app.use('/api/schedule/*', authMiddleware);
  app.use('/api/appointments/*', authMiddleware);
  app.use('/api/practice/*', authMiddleware);
  app.use('/api/service-lines/*', authMiddleware);
  app.use('/api/agent/*', authMiddleware);

  // Audit middleware for PHI endpoints (also before route registration)
  app.use('/api/patients/*', createAuditMiddleware(pool));
  app.use('/api/appointments/*', createAuditMiddleware(pool));

  // Auth routes (login/refresh are public, users/agent-keys are protected above)
  const authRoutes = createAuthRoutes(authService);
  app.route('/api/auth', authRoutes);

  // Schedule routes (auth middleware already registered for /api/schedule/*)
  const scheduleRoutes = createScheduleRoutes(scheduleService);
  app.route('/api/schedule', scheduleRoutes);

  // Patient routes (auth + audit middleware already registered for /api/patients/*)
  const patientRoutes = createPatientRoutes(patientService);
  app.route('/api/patients', patientRoutes);

  return { app, eventBus, authService };
}
