import { createMiddleware } from 'hono/factory';
import type pg from 'pg';
import type { AuthContext } from './auth.js';

const PHI_PATHS = ['/api/patients', '/api/appointments', '/api/clinical'];

function isPHIPath(path: string): boolean {
  return PHI_PATHS.some(p => path.startsWith(p));
}

export function createAuditMiddleware(pool: pg.Pool) {
  return createMiddleware<{ Variables: { auth: AuthContext } }>(async (c, next) => {
    await next();

    if (!isPHIPath(c.req.path)) return;

    const auth = c.get('auth');
    if (!auth) return;

    const method = c.req.method;
    let action: string;
    if (method === 'GET') action = 'access';
    else if (method === 'POST') action = 'create';
    else if (method === 'PUT' || method === 'PATCH') action = 'update';
    else if (method === 'DELETE') action = 'delete';
    else return;

    try {
      await pool.query(
        `INSERT INTO audit_events
          (practice_id, entity_type, entity_id, action, actor_id, actor_type, ip_address, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          auth.practiceId,
          'http_request',
          '00000000-0000-0000-0000-000000000000',
          action,
          auth.userId,
          auth.actorType,
          c.req.header('x-forwarded-for') ?? 'localhost',
          JSON.stringify({ method, path: c.req.path, status: c.res.status }),
        ],
      );
    } catch (err) {
      console.error('Audit logging failed:', err);
    }
  });
}
