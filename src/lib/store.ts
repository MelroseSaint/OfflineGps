import { useSyncExternalStore } from 'react';

/**
 * Tiny observable store (~40 lines) — avoids pulling in a state library.
 * State is a plain immutable object updated via `set`.
 */
export class Store<T extends object> {
  private listeners = new Set<() => void>();
  constructor(private state: T) {}

  /** Bound so it can be passed as a callback (useSyncExternalStore). */
  get = (): T => {
    return this.state;
  };

  set = (patch: Partial<T> | ((prev: T) => Partial<T>)): void => {
    const p = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  };

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
}

export function useStore<T extends object>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
