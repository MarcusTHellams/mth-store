/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable @typescript-eslint/no-explicit-any */

type Listener<T> = (newState: T, prevState: T) => void;
type SetState<T> = (newStateOrFn: T | ((prevState: T) => T)) => void;

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
        listener(newState as T, oldState);
      });
      return;
    }
    const newState = newStateOrFn instanceof Function ? newStateOrFn(oldState) : newStateOrFn;
    // persist the computed state, then notify listeners
    this._state = newState as T;
    this._listeners.forEach((listener) => {
      listener(newState as T, oldState);
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
    // arrays that will collect dep values in the order notifications arrive
    let currentDepVals: Array<DepState<Deps[number]>> = [];
    let prevDepVals: Array<DepState<Deps[number]>> = [];
    let prevState = this._state;
    this._deps.forEach((dep) => {
      this._subs.add(
        dep.subscribe((newState, oldState) => {
          this._deps.forEach((_dep) => {
            if (_dep === dep) {
              currentDepVals.push(newState);
              prevDepVals.push(oldState);
            } else {
              currentDepVals.push(_dep.getState());
              prevDepVals.push(_dep.getState());
            }
          });
          const newStateVal = this._fn({
            prevVal: prevState,
            currentDepVals: currentDepVals as unknown as {
              [K in keyof Deps]: DepState<Deps[K]>;
            },
            prevDepVals: prevDepVals as unknown as { [K in keyof Deps]: DepState<Deps[K]> },
          });
          this._listeners.forEach((listener) => {
            listener(newStateVal, prevState);
          });
          prevState = newStateVal;
          this._state = newStateVal;
          currentDepVals = [];
          prevDepVals = [];
        }),
      );
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
    this._deps.forEach((dep) => {
      this._subs.add(
        dep.subscribe(() => {
          this._fn();
        }),
      );
    });
    return () => this._subs.forEach((unsub) => unsub());
  };
}
