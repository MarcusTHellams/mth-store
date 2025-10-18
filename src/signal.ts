import { dequal } from 'dequal';

/* eslint-disable @typescript-eslint/no-explicit-any */
let __currentComputed: Computed<any> | null = null;
let __trackDeps = false;

/**
 * This is here to solve the pyramid dependency problem where:
 *       A
 *      / \
 *     B   C
 *      \ /
 *       D
 *
 * Where we deeply traverse this tree, how do we avoid D being recomputed twice; once when B is updated, once when C is.
 *
 * To solve this, we create linkedDeps that allows us to sync avoid writes to the state until all of the deps have been
 * resolved.
 *
 * This is a record of stores, because derived stores are not able to write values to, but stores are
 */

export const __signalToComputed = new WeakMap<Signal<unknown>, Set<Computed<unknown>>>();
// Map from a Computed to Computeds that depend on it. This allows us to
// notify only true computed dependents when a computed changes, instead of
// traversing via signals which may be shared among unrelated computeds.
export const __computedToComputed = new WeakMap<Computed<unknown>, Set<Computed<unknown>>>();

/**
 * Tracks which Signals or Computeds have performed a write during the
 * current flush/tick. This set is used for two related purposes:
 *
 * 1. Prevent duplicate or out-of-order recomputations when multiple
 *    dependencies update in the same flush. If a dependency has already
 *    "written" during this tick, downstream computed values can avoid
 *    re-applying or double-applying updates.
 *
 * 2. Provide a way for writable computeds to determine whether any of
 *    their dependencies were written in the current tick. When a
 *    dependency write occurs in the same batch as a manual write to a
 *    writable computed, the dependency-driven update should generally
 *    take precedence. Consumers can check this set to decide whether to
 *    discard a manual override and recompute from the compute function.
 *
 * Note: this set is cleared at the end of each flush cycle.
 */
export const __depsThatHaveWrittenThisTick = new Set<Computed<unknown> | Signal<unknown>>();

let __isFlushing = false;
let __batchDepth = 0;
// pending updates can be Signals or Computeds (for writable computeds)
const __pendingUpdates = new Set<Signal<unknown> | Computed<unknown>>();
// Add a map to store initial values before batch
const __initialBatchValues = new Map<any, unknown>();

// this function is to get all the computed values to recompute
function __flush_internals(relatedValues: Set<Computed<unknown>>) {
  // Use insertion order but avoid duplicates via __depsThatHaveWrittenThisTick (now a Set)
  const sorted = Array.from(relatedValues).sort((a, b) => {
    // If a depends on b, b should go first
    if (a instanceof Computed && a.deps.has(b)) return 1;
    // If b depends on a, a should go first
    if (b instanceof Computed && b.deps.has(a)) return -1;
    return 0;
  });

  for (const computed of sorted) {
    // Compute candidate once to avoid double-evaluation. Use the candidate
    // both to check staleness and to pass into recompute.
    const candidate = (computed as any).computeFn();
    const isStale = computed.peek() !== candidate;

    // If it's stale and none of its dependencies have already written this
    // tick, recompute now using the candidate.
    if (isStale && !__depsThatHaveWrittenThisTick.has(computed)) {
      computed.recompute(candidate);
    }

    // If this computed has already been recorded as "written" this tick,
    // skip reprocessing it to avoid double-work or ordering issues.
    if (__depsThatHaveWrittenThisTick.has(computed)) {
      continue;
    }

    // Mark this computed as having been handled in this tick so downstream
    // traversals know not to re-run it again in the same flush cycle. If it
    // wasn't stale above, recompute now (passing the candidate to avoid
    // another computeFn invocation).
    __depsThatHaveWrittenThisTick.add(computed);
    if (!isStale) {
      computed.recompute(candidate);
    }

    // Notify computed dependents (computeds that read this computed).
    const computedDependents = __computedToComputed.get(computed);
    if (computedDependents) {
      __flush_internals(computedDependents);
    }
  }
}

/**
 * @private only to be called from `Signal` on write
 */

export function __flush(signal: Signal<any> | Computed<any>) {
  // If we're starting a batch, signal the initial values
  if (__batchDepth > 0 && !__initialBatchValues.has(signal)) {
    // store prevValue for both Signals and Computeds
    __initialBatchValues.set(signal, (signal as any).prevValue);
  }

  __pendingUpdates.add(signal);

  if (__batchDepth > 0) return;
  if (__isFlushing) return;
  try {
    __isFlushing = true;
    while (__pendingUpdates.size > 0) {
      const signals = Array.from(__pendingUpdates);
      __pendingUpdates.clear();

      // Process Signal updates first, then Computed updates.
      // This ensures that underlying store/signal writes in the same batch
      // are applied before writable computeds (which may have been written
      // manually) are recomputed. That allows dependency-triggered
      // recomputations to clear manual overrides when appropriate.
      const signalItems = signals.filter((s) => s instanceof Signal) as Signal<unknown>[];
      const computedItems = signals.filter((s) => !(s instanceof Signal)) as Computed<unknown>[];

      for (const item of signalItems) {
        const prevValue = __initialBatchValues.get(item) ?? item.prevValue;
        item.prevValue = prevValue;

        const computedVals = __signalToComputed.get(item);
        if (!computedVals) continue;
        // Mark this Signal as having written during this tick so downstream
        // computations can know a dependency produced a change. This lets
        // writable computeds decide whether to keep their manual override or
        // prefer a dependency-driven recompute.
        __depsThatHaveWrittenThisTick.add(item as any);
        __flush_internals(computedVals);
      }

      for (const item of computedItems) {
        // item is a Computed
        __flush_internals(new Set([item as Computed<unknown>]));
      }
    }
  } finally {
    __isFlushing = false;
    __depsThatHaveWrittenThisTick.clear();
    __initialBatchValues.clear();
  }
}

/**
 * @private
 */
export type Listener<T> = (value: T, prevValue: T) => void;

export class Signal<T> {
  #value: T;
  prevValue: T;
  constructor(value: T) {
    this.#value = value;
    this.prevValue = value;
  }
  get value() {
    if (__trackDeps && __currentComputed) {
      __currentComputed.deps.add(this);
    }
    return this.#value;
  }
  set value(newValue: T) {
    if (dequal(newValue, this.#value)) {
      return;
    }
    this.prevValue = this.peek();
    this.#value = newValue;
    __flush(this);
  }
  peek = () => this.#value;
}

export function signal<T>(value: T) {
  return new Signal(value);
}

export class Computed<T> {
  protected _value!: T;
  prevValue!: T;
  deps = new Set<Signal<any> | Computed<any>>();
  #afterInit = false;
  protected onUpdate: (() => void) | undefined = undefined;
  protected computeFn: () => T;
  constructor(computeFn: () => T, onUpdate?: () => void) {
    this.computeFn = computeFn;
    this.onUpdate = onUpdate;
  }
  // Accept an optional precomputed value to avoid calling computeFn twice
  // during a flush cycle. If `value` is provided we use it directly,
  // otherwise we call the compute function.
  recompute = (value?: T) => {
    this.prevValue = !this.#afterInit
      ? this.computeFn()
      : ((__initialBatchValues.get(this) ?? this.peek()) as T);
    this.#afterInit = true;
    if (value === undefined) {
      this._value = this.computeFn();
    } else {
      this._value = value;
    }
    this.onUpdate?.();
  };

  get value() {
    // If dependency tracking is active, register this computed as a dependency
    // of the currently-tracked computed (unless it's the same computed) so
    // that effects/computeds that read this computed will re-run when its
    // underlying signals change.
    if (__trackDeps && __currentComputed && __currentComputed !== this) {
      __currentComputed.deps.add(this as never);
    }
    return this._value;
  }

  peek = () => this._value;

  registerOnGraph(deps: Set<Signal<any> | Computed<any>> = this.deps) {
    for (const dep of deps) {
      if (dep instanceof Computed) {
        // First register the intermediate computed value if it's not already registered
        dep.registerOnGraph();
        // Record that this computed depends on `dep` so we can notify direct
        // computed dependents when `dep` changes.
        let relatedComputedVals = __computedToComputed.get(dep);
        if (!relatedComputedVals) {
          relatedComputedVals = new Set();
          __computedToComputed.set(dep, relatedComputedVals);
        }
        relatedComputedVals.add(this as never);
        // Then register this computed with the dep's underlying stores
        this.registerOnGraph(dep.deps);
      } else if (dep instanceof Signal) {
        // Register the computed as related computed to the signal
        let relatedLinkedComputedVals = __signalToComputed.get(dep);
        if (!relatedLinkedComputedVals) {
          relatedLinkedComputedVals = new Set();
          __signalToComputed.set(dep, relatedLinkedComputedVals);
        }
        relatedLinkedComputedVals.add(this as never);
      }
    }
  }

  unregisterFromGraph(deps: Set<Signal<any> | Computed<any>> = this.deps) {
    for (const dep of deps) {
      if (dep instanceof Computed) {
        // Remove this computed from the dep's computed-dependents mapping.
        const relatedComputedVals = __computedToComputed.get(dep);
        if (relatedComputedVals) {
          relatedComputedVals.delete(this as never);
        }
        this.unregisterFromGraph(dep.deps);
      } else if (dep instanceof Signal) {
        const relatedLinkedComputedVals = __signalToComputed.get(dep);
        if (relatedLinkedComputedVals) {
          relatedLinkedComputedVals.delete(this as never);
        }
      }
    }
    this.deps.clear();
  }
}

export function computed<T>(fn: () => T) {
  __trackDeps = true;
  const computed = new Computed(fn);
  __currentComputed = computed;
  computed.recompute();
  computed.registerOnGraph();
  __currentComputed = null;
  __trackDeps = false;
  return computed;
}

export class WritableComputed<T> extends Computed<T> {
  #isWriting = false;
  #writingValue: T | null = null;
  #afterInit = false;

  constructor(fn: () => T) {
    super(fn);
  }
  // Writable computed no longer exposes isStale; instead we rely on the
  // flush cycle to compute a single candidate value and pass it here.
  recompute = (value?: T) => {
    if (this.#isWriting) {
      // If any dependency wrote this tick, prefer dependency-driven recompute
      // and discard the manual write. Otherwise commit the manual write.
      let depWritten = false;
      for (const dep of this.deps) {
        if (__depsThatHaveWrittenThisTick.has(dep)) {
          depWritten = true;
          break;
        }
      }
      if (!depWritten) {
        this.prevValue = (__initialBatchValues.get(this) ?? this.peek()) as T;
        this._value = this.#writingValue as T;
        this.#isWriting = false;
        this.#writingValue = null;
        this.onUpdate?.();
        return;
      }
      // A dependency was written this tick: discard the manual write and fall
      // through to recompute from the provided value or computeFn.
      this.#isWriting = false;
      this.#writingValue = null;
    }
    this.prevValue = !this.#afterInit
      ? this.computeFn()
      : ((__initialBatchValues.get(this) ?? this.peek()) as T);
    this.#afterInit = true;
    if (value === undefined) {
      this._value = this.computeFn();
    } else {
      this._value = value;
    }
    this.onUpdate?.();
  };
  get value() {
    if (__trackDeps && __currentComputed && __currentComputed !== this) {
      __currentComputed.deps.add(this as never);
    }
    return this._value;
  }
  set value(newValue: T) {
    if (dequal(newValue, this._value)) {
      return;
    }
    this.#isWriting = true;
    this.#writingValue = newValue;
    __flush(this);
  }
}

export function writableComputed<T>(fn: () => T) {
  __trackDeps = true;
  const computed = new WritableComputed(fn);
  __currentComputed = computed;
  computed.recompute();
  computed.registerOnGraph();
  __currentComputed = null;
  __trackDeps = false;
  return computed;
}

export class Effect {
  #computed: Computed<void> | undefined = undefined;
  unregister: () => void;
  constructor(fn: () => void) {
    this.#computed = new Computed(
      () => {},
      () => fn(),
    );
    __trackDeps = true;
    __currentComputed = this.#computed;
    this.#computed.recompute();
    this.#computed.registerOnGraph();
    __currentComputed = null;
    __trackDeps = false;
    this.unregister = this.#computed.unregisterFromGraph;
  }
}

export function effect(fn: () => void) {
  return new Effect(fn).unregister;
}

export function batch(fn: () => void) {
  __batchDepth++;
  try {
    fn();
  } finally {
    __batchDepth--;
    if (__batchDepth === 0) {
      const pendingUpdateToFlush = __pendingUpdates.values().next().value;
      if (pendingUpdateToFlush) {
        __flush(pendingUpdateToFlush); // Trigger flush of all pending updates
      }
    }
  }
}

export function untrack<T>(fn: () => T) {
  const prevTrackDeps = __trackDeps;
  const prevCurrentComputed = __currentComputed;
  __trackDeps = false;
  __currentComputed = null;
  const result = fn();
  __trackDeps = prevTrackDeps;
  __currentComputed = prevCurrentComputed;
  return result;
}

const count = signal(1);
const double = writableComputed(() => count.value * 2);

double.value = 0;
