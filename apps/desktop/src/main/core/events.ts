import type { SaEvent } from '@sa/shared';

export type SaEventListener = (event: SaEvent) => void;

/** Push events for the renderer (SA_EVENT_CHANNEL). Listeners never break emitters. */
export class EventBus {
  private readonly listeners = new Set<SaEventListener>();

  on(listener: SaEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: SaEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a broken listener (e.g. a destroyed window) must not affect the others
      }
    }
  }
}
