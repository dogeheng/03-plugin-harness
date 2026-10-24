import type { HostEvent } from "@harness/shared";

type Listener = (e: HostEvent) => void;

/** Synchronous fan-out bus. Listener errors are isolated from each other. */
export class EventBus {
  private readonly listeners = new Set<Listener>();

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: HostEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        // A broken subscriber must never affect the emitter or other subscribers.
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
