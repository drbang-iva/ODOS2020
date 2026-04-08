import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { createAuditHandler } from '../../../src/server/events/handlers/audit.handler.js';
import { InProcessEventBus } from '../../../src/server/events/bus.js';
import type { DomainEvent } from '../../../src/server/events/types.js';
import { runMigrations } from '../../../src/server/db/migrate.js';

const TEST_DB_URL = 'postgresql://osod:osod_dev@localhost:5432/osod_test';

describe('audit.handler', () => {
  let pool: pg.Pool;
  let bus: InProcessEventBus;

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    // Clean audit_events by dropping and recreating (trigger blocks DELETE)
    await pool.query('DROP TABLE IF EXISTS audit_events CASCADE');
    await pool.query('DROP TABLE IF EXISTS _migrations CASCADE');
    // Drop all tables to avoid FK issues
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pool.end();
    await runMigrations(TEST_DB_URL);
    pool = new pg.Pool({ connectionString: TEST_DB_URL });

    bus = new InProcessEventBus();
    const handler = createAuditHandler(pool);
    bus.on('*', handler);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('writes domain events to audit_events table', async () => {
    const entityId = '11111111-1111-1111-1111-111111111111';
    const event: DomainEvent = {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      type: 'patient.created',
      timestamp: new Date().toISOString(),
      practiceId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      actorId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      actorType: 'human',
      entityType: 'patient',
      entityId,
      payload: { firstName: 'John', lastName: 'Doe' },
      correlationId: 'corr-1',
    };

    await bus.emit(event);

    const result = await pool.query('SELECT * FROM audit_events WHERE entity_id = $1', [entityId]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].entity_type).toBe('patient');
    expect(result.rows[0].action).toBe('create');
    expect(result.rows[0].actor_type).toBe('human');
  });

  it('maps event type to action correctly', async () => {
    const entityId = '22222222-2222-2222-2222-222222222222';
    const updateEvent: DomainEvent = {
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      type: 'patient.updated',
      timestamp: new Date().toISOString(),
      practiceId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      actorId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      actorType: 'human',
      entityType: 'patient',
      entityId,
      payload: { changes: { email: 'new@test.com' } },
      correlationId: 'corr-2',
    };

    await bus.emit(updateEvent);

    const result = await pool.query('SELECT action FROM audit_events WHERE entity_id = $1', [entityId]);
    expect(result.rows[0].action).toBe('update');
  });

  it('writes previous_state and new_state snapshots when present on the event', async () => {
    const entityId = '33333333-3333-3333-3333-333333333333';
    const event: DomainEvent = {
      id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      type: 'patient.updated',
      timestamp: new Date().toISOString(),
      practiceId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      actorId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      actorType: 'human',
      entityType: 'patient',
      entityId,
      payload: { changes: { email: 'new@test.com' } },
      correlationId: 'corr-snap',
      previousState: { email: 'old@test.com', phone: '555-0000' },
      newState: { email: 'new@test.com', phone: '555-0000' },
    };

    await bus.emit(event);

    const result = await pool.query(
      'SELECT previous_state, new_state FROM audit_events WHERE entity_id = $1',
      [entityId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].previous_state).toEqual({ email: 'old@test.com', phone: '555-0000' });
    expect(result.rows[0].new_state).toEqual({ email: 'new@test.com', phone: '555-0000' });
  });

  it('leaves previous_state and new_state NULL when not provided', async () => {
    const entityId = '44444444-4444-4444-4444-444444444444';
    const event: DomainEvent = {
      id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      type: 'patient.created',
      timestamp: new Date().toISOString(),
      practiceId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      actorId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      actorType: 'human',
      entityType: 'patient',
      entityId,
      payload: { firstName: 'X' },
      correlationId: 'corr-no-snap',
    };

    await bus.emit(event);

    const result = await pool.query(
      'SELECT previous_state, new_state FROM audit_events WHERE entity_id = $1',
      [entityId],
    );
    expect(result.rows[0].previous_state).toBeNull();
    expect(result.rows[0].new_state).toBeNull();
  });
});
