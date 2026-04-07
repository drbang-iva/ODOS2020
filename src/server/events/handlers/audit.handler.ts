import type pg from 'pg';
import type { DomainEvent } from '../types.js';

function extractAction(eventType: string): string {
  if (eventType.includes('created') || eventType.includes('scheduled')) return 'create';
  if (eventType.includes('updated') || eventType.includes('changed')) return 'update';
  if (eventType.includes('cancelled') || eventType.includes('deleted')) return 'delete';
  if (eventType.includes('resolved') || eventType.includes('reviewed') || eventType.includes('matched')) return 'update';
  if (eventType.includes('received')) return 'create';
  return 'access';
}

export function createAuditHandler(pool: pg.Pool) {
  return async (event: DomainEvent): Promise<void> => {
    await pool.query(
      `INSERT INTO audit_events
        (id, practice_id, entity_type, entity_id, action, actor_id, actor_type, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        event.id,
        event.practiceId,
        event.entityType,
        event.entityId,
        extractAction(event.type),
        event.actorId,
        event.actorType,
        JSON.stringify({ eventType: event.type, correlationId: event.correlationId, payload: event.payload }),
        event.timestamp,
      ],
    );
  };
}
