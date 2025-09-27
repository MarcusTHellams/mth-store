/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable @typescript-eslint/no-explicit-any */

type Listener<T> = (newState: T, prevState: T) => void;
type SetState<T> = (newStateOrFn: T | ((prevState: T) => T)) => void;

// Basic global batching utilities. Multiple setState calls wrapped in `batch()`
// will only notify subscribers once (per logical subscriber owner) when the
// batch finishes. Nested batching is supported.
let __batchLevel = 0;
type PendingCall = { listener: Listener<any>; newState: any; oldState: any };
const __pendingCalls: PendingCall[] = [];

function __notifyListenerImmediate<T>(listener: Listener<T>, newState: T, oldState: T) {
  try {
    listener(newState, oldState);
  } catch (err) {
    // swallow listener errors to avoid breaking other listeners
    // Users can still surface errors from their own listeners if needed
    // but we avoid crashing the batch notifier.
    setTimeout(() => {
      throw err;
    }, 0);
  }
}

function __flushPending() {
  if (__pendingCalls.length === 0) return;

  // Aggregate pending calls by logical owner. For each owner we keep the
  // representative listener (first encountered), the owner object, and the
  // list of calls so owner-specific handlers can reconstruct prev/current
  // dep values.
  const aggregated = new Map<any, { owner: any; listener: Listener<any>; calls: PendingCall[] }>();
  for (const call of __pendingCalls) {
    const owner = (call.listener as any).__batchOwner ?? call.listener;
    if (!aggregated.has(owner)) {
      aggregated.set(owner, { owner, listener: call.listener, calls: [] });
    }
    aggregated.get(owner)!.calls.push(call);
  }

  // Clear pendingCalls before invoking to allow nested batches triggered by
  // listeners to work correctly.
  __pendingCalls.length = 0;

  aggregated.forEach(({ owner, listener, calls }) => {
    // If the owner (object/function) has a custom batch handler, call it
    // with all calls. This is where Derived/Effect will reconstruct state
    // and invoke their listeners once.
    const batchHandler = (owner as any).__batchHandler ?? (listener as any).__batchHandler;
    if (typeof batchHandler === 'function') {
      try {
        batchHandler(calls);
      } catch (err) {
        setTimeout(() => {
          throw err;
        }, 0);
      }
      return;
    }

    // Default: notify using the last call's newState/oldState
    const last = calls[calls.length - 1];
    __notifyListenerImmediate(listener, last.newState, last.oldState);
  });
}

/**
 * Run a function inside a batch. All store notifications are deferred and
 * deduplicated so logical subscribers (Derived/Effect owners) are only
 * invoked once with the final state.
 */
export function batch<T>(fn: () => T): T {
  __batchLevel++;
  try {
    return fn();
  } finally {
    __batchLevel--;
    if (__batchLevel === 0) {
      __flushPending();
    }
  }
}

function __queueOrNotify<T>(listener: Listener<T>, newState: T, oldState: T) {
  if (__batchLevel > 0) {
    __pendingCalls.push({ listener: listener as Listener<any>, newState, oldState });
  } else {
    __notifyListenerImmediate(listener, newState, oldState);
  }
}

export class Store<T = unknown> {
  private _listeners = new Set<Listener<T>>();
  private _state: T;
  private _initState: T;
  // @ts-expect-error
  private _updateFn: (prevState: T) => (updateValue: T | ((prevState: T) => T)) => T | undefined =
    undefined;
  constructor(
    initState: T,
    opts?: {
      updateFn?: (prevState: T) => (updateValue: T | ((prevState: T) => T)) => T;
    },
  ) {
    const { updateFn } = opts || {};
    this._state = initState;
    this._initState = initState;
    if (updateFn) {
      this._updateFn = updateFn;
    }
  }
  getInitialState = () => {
    return this._initState;
  };
  getState = () => {
    return this._state;
  };

  subscribe = (listener: Listener<T>, opts?: { greedy: boolean }): (() => void) => {
    this._listeners.add(listener);
    if (opts?.greedy) {
      listener(this._state, this._state);
    }
    return () => {
      this._listeners.delete(listener);
    };
  };
  setState: SetState<T> = (newStateOrFn) => {
    const oldState = this._state;
    if (this._updateFn) {
      const newState = this._updateFn(oldState)(newStateOrFn);
      this._state = newState as T;
      this._listeners.forEach((listener) => {
        __queueOrNotify(listener, newState as T, oldState);
      });
      return;
    }
    const newState = newStateOrFn instanceof Function ? newStateOrFn(oldState) : newStateOrFn;
    // persist the computed state, then notify listeners
    this._state = newState as T;
    this._listeners.forEach((listener) => {
      __queueOrNotify(listener, newState as T, oldState);
    });
  };
}

// Helper to extract a Store's state type
type DepState<D> = D extends Store<infer S> ? S : never;

type DerivedFn<Deps extends ReadonlyArray<Store<any>>, R> = (params: {
  prevVal: R | undefined;
  // preserve tuple order/length for deps
  prevDepVals: { [K in keyof Deps]: DepState<Deps[K]> };
  currentDepVals: { [K in keyof Deps]: DepState<Deps[K]> };
}) => R;

export class Derived<R = unknown, Deps extends ReadonlyArray<Store<any>> = Array<Store<any>>> {
  private _deps: Deps;
  private _fn: DerivedFn<Deps, R>;
  private _subs = new Set<() => void>();
  private _state: R;
  private _listeners = new Set<Listener<R>>();

  constructor({ fn, deps }: { fn: DerivedFn<Deps, R>; deps: Deps }) {
    this._fn = fn;
    // store deps first so we can compute initial dep values
    this._deps = deps;
    // compute initial dep values and call fn with them so legacy users relying on deps work
    const initDepVals = this._deps.map((d) => d.getState()) as unknown as {
      [K in keyof Deps]: DepState<Deps[K]>;
    };
    this._state = this._fn({
      currentDepVals: initDepVals,
      prevVal: undefined,
      prevDepVals: initDepVals,
    });
  }
  getState = () => {
    return this._state;
  };
  subscribe = (listener: Listener<R>, opts?: { greedy: boolean }): (() => void) => {
    this._listeners.add(listener);
    if (opts?.greedy) {
      listener(this._state, this._state);
    }
    return () => {
      this._listeners.delete(listener);
    };
  };
  mount = () => {
    let prevState = this._state;
    const depWrappers: Array<Listener<any>> = [];
    const wrapperCache = new WeakMap<Listener<R>, Listener<R>>();

    // attach a batch handler on this Derived instance. When flush runs it will
    // call this handler (with calls array) to compute the derived value once.
    (this as any).__batchHandler = (calls: PendingCall[]) => {
      // For each dep, see if there's a call whose listener is the depWrapper
      const prevDepVals = this._deps.map((d) => d.getState()) as unknown as Array<DepState<Deps[number]>>;
      const currentDepVals = this._deps.map((d) => d.getState()) as unknown as Array<DepState<Deps[number]>>;

      for (let i = 0; i < depWrappers.length; i++) {
        const wrapper = depWrappers[i];
        const callsForDep = calls.filter((c) => c.listener === wrapper);
        if (callsForDep.length > 0) {
          // take last call for current, and first call.oldState for prev
          const first = callsForDep[0];
          const last = callsForDep[callsForDep.length - 1];
          prevDepVals[i] = first.oldState as DepState<Deps[number]>;
          currentDepVals[i] = last.newState as DepState<Deps[number]>;
        }
      }

      const newStateVal = this._fn({ prevVal: prevState, currentDepVals: currentDepVals as any, prevDepVals: prevDepVals as any });
      this._listeners.forEach((listener) => {
        let wrapped = wrapperCache.get(listener);
        if (!wrapped) {
          wrapped = ((ns: R, ps: R) => listener(ns, ps)) as Listener<R>;
          wrapperCache.set(listener, wrapped);
        }
        (wrapped as any).__batchOwner = listener;
        __queueOrNotify(wrapped, newStateVal, prevState);
      });
      prevState = newStateVal;
      this._state = newStateVal;
    };

    this._deps.forEach((dep, i) => {
      const depWrapper: Listener<any> = ((newState, oldState) => {
        if (__batchLevel > 0) {
          // when batching we don't compute now; the wrapper will be queued
          // and the Derived's __batchHandler will be invoked with all calls
          return;
        }
        // not batching: compute immediately using the changed dep's new/old state
        const currentDepVals = this._deps.map((d, idx) => (idx === i ? newState : d.getState())) as unknown as {
          [K in keyof Deps]: DepState<Deps[K]>;
        };
        const prevDepVals = this._deps.map((d, idx) => (idx === i ? oldState : d.getState())) as unknown as {
          [K in keyof Deps]: DepState<Deps[K]>;
        };
        const newStateVal = this._fn({ prevVal: prevState, currentDepVals, prevDepVals });
        this._listeners.forEach((listener) => listener(newStateVal, prevState));
        prevState = newStateVal;
        this._state = newStateVal;
      }) as Listener<any>;
      (depWrapper as any).__batchOwner = this;
      depWrappers.push(depWrapper);
      this._subs.add(dep.subscribe(depWrapper));
    });
    return () => {
      this._subs.forEach((unsub) => unsub());
      this._subs.forEach((sub) => this._subs.delete(sub));
      this._listeners.forEach((listener) => this._listeners.delete(listener));
    };
  };
}

export class Effect<
  Deps extends ReadonlyArray<Store<any> | Derived<any>> = Array<Store<any> | Derived<any>>,
> {
  private _deps: Deps;
  private _fn: () => void;
  private _subs = new Set<() => void>();
  private _eager = false;
  constructor({ fn, deps, eager = false }: { fn: () => void; deps: Deps; eager?: boolean }) {
    this._fn = fn;
    this._deps = deps;
    this._eager = eager;
  }
  mount = () => {
    if (this._eager) {
      this._fn();
    }
    // single persistent wrapper for this Effect instance
    const wrapper = (() => {
      this._fn();
    }) as unknown as Listener<any>;
    (wrapper as any).__batchOwner = this;
    this._deps.forEach((dep) => {
      const unsub = dep.subscribe(wrapper);
      this._subs.add(unsub);
    });
    return () => this._subs.forEach((unsub) => unsub());
  };
}
