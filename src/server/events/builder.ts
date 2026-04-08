import { randomUUID } from 'node:crypto';
import type { DomainEvent } from './types.js';

/**
 * Shared actor context — every mutating service method receives this so
 * emitted events always identify who made the change. Built in route
 * handlers from the JWT's AuthContext.
 */
export interface ActorContext {
  userId: string;
  practiceId: string;
  actorType: 'human' | 'local_agent' | 'cloud_agent';
  /** Optional correlation id — used to link related events in the same request. */
  correlationId?: string;
}

export interface BuildEventInput {
  type: string;
  entityType: string;
  entityId: string;
  payload: unknown;
  previousState?: Record<string, unknown> | object | null;
  newState?: Record<string, unknown> | object | null;
}

/**
 * Stamp an event with id, timestamp, and actor/correlation metadata so
 * callers don't have to repeat that boilerplate.
 */
export function buildEvent(actor: ActorContext, input: BuildEventInput): DomainEvent {
  return {
    id: randomUUID(),
    type: input.type,
    timestamp: new Date().toISOString(),
    practiceId: actor.practiceId,
    actorId: actor.userId,
    actorType: actor.actorType,
    entityType: input.entityType,
    entityId: input.entityId,
    payload: input.payload,
    correlationId: actor.correlationId ?? randomUUID(),
    previousState: input.previousState,
    newState: input.newState,
  };
}
