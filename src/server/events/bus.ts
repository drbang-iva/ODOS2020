import type { DomainEvent } from './types.js';

type EventHandler = (event: DomainEvent) => Promise<void>;

export interface DomainEventBus {
  emit(event: DomainEvent): Promise<void>;
  on(eventType: string, handler: EventHandler): void;
  off(eventType: string, handler: EventHandler): void;
}

export class InProcessEventBus implements DomainEventBus {
  private handlers = new Map<string, EventHandler[]>();

  on(eventType: string, handler: EventHandler): void {
    const existing = this.handlers.get(eventType) ?? [];
    existing.push(handler);
    this.handlers.set(eventType, existing);
  }

  off(eventType: string, handler: EventHandler): void {
    const existing = this.handlers.get(eventType);
    if (!existing) return;
    this.handlers.set(
      eventType,
      existing.filter(h => h !== handler),
    );
  }

  async emit(event: DomainEvent): Promise<void> {
    const specific = this.handlers.get(event.type) ?? [];
    const wildcard = this.handlers.get('*') ?? [];
    const all = [...specific, ...wildcard];

    for (const handler of all) {
      await handler(event);
    }
  }
}
