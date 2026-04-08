import { describe, it, expect, vi } from 'vitest';
import { InProcessEventBus } from '../../../src/server/events/bus.js';
import type { DomainEvent } from '../../../src/server/events/types.js';

function makeEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    id: 'evt-1',
    type: 'patient.created',
    timestamp: new Date().toISOString(),
    practiceId: 'practice-1',
    actorId: 'user-1',
    actorType: 'human',
    entityType: 'patient',
    entityId: 'patient-1',
    payload: {},
    correlationId: 'corr-1',
    ...overrides,
  };
}

describe('InProcessEventBus', () => {
  it('delivers events to subscribers', async () => {
    const bus = new InProcessEventBus();
    const handler = vi.fn();
    bus.on('patient.created', handler);

    const event = makeEvent();
    await bus.emit(event);

    expect(handler).toHaveBeenCalledWith(event);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not deliver events to unrelated subscribers', async () => {
    const bus = new InProcessEventBus();
    const handler = vi.fn();
    bus.on('appointment.scheduled', handler);

    await bus.emit(makeEvent({ type: 'patient.created' }));

    expect(handler).not.toHaveBeenCalled();
  });

  it('supports multiple subscribers for the same event', async () => {
    const bus = new InProcessEventBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    bus.on('patient.created', handler1);
    bus.on('patient.created', handler2);

    await bus.emit(makeEvent());

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it('supports wildcard (*) subscribers', async () => {
    const bus = new InProcessEventBus();
    const handler = vi.fn();
    bus.on('*', handler);

    await bus.emit(makeEvent({ type: 'patient.created' }));
    await bus.emit(makeEvent({ type: 'appointment.scheduled' }));

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('unsubscribes with off()', async () => {
    const bus = new InProcessEventBus();
    const handler = vi.fn();
    bus.on('patient.created', handler);
    bus.off('patient.created', handler);

    await bus.emit(makeEvent());

    expect(handler).not.toHaveBeenCalled();
  });

  it('awaits all handlers (synchronous guarantee)', async () => {
    const bus = new InProcessEventBus();
    const order: number[] = [];

    bus.on('patient.created', async () => {
      await new Promise(r => setTimeout(r, 10));
      order.push(1);
    });
    bus.on('patient.created', async () => {
      order.push(2);
    });

    await bus.emit(makeEvent());

    expect(order).toEqual([1, 2]);
  });
});
