/* eslint-disable @typescript-eslint/no-explicit-any */
import { Store, Derived, Effect } from '../src/store';

describe('Store', () => {
  it('exposes initial and current state', () => {
    const s = new Store(1);
    expect(s.getInitialState()).toBe(1);
    expect(s.getState()).toBe(1);
  });

  it('subscribe/unsubscribe works and greedy emits immediately', () => {
    const s = new Store({ x: 1 });
    const listener = vi.fn();
    const unsub = s.subscribe(listener, { greedy: true });

    // greedy: should receive once with (state, state)
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith({ x: 1 }, { x: 1 });

    // update -> listener is called with (newState, oldState)
    s.setState({ x: 2 });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith({ x: 2 }, { x: 1 });

    unsub();
    s.setState({ x: 3 });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('setState accepts value or updater fn', () => {
    const s = new Store(0);
    s.setState(1);
    expect(s.getState()).toBe(1);

    s.setState((prev) => prev + 2);
    expect(s.getState()).toBe(3);
  });

  it('respects custom updateFn pipeline', () => {
    // updateFn receives prevState and returns a function that takes updateValue (value or fn)
    // and must return the new state. We'll implement a reducer-like behavior.
    const updateFn = (prev: number) => (update: number | ((p: number) => number)) => {
      const next = typeof update === 'function' ? (update as any)(prev) : update;
      return prev + next; // accumulate
    };

    const s = new Store(10, { updateFn });
    const listener = vi.fn();
    s.subscribe(listener);

    s.setState(5); // 10 + 5 = 15
    expect(s.getState()).toBe(15);
    expect(listener).toHaveBeenLastCalledWith(15, 10);

    s.setState((p) => p * 2); // 15 + (prev*2=30) => 45
    expect(s.getState()).toBe(45);
    expect(listener).toHaveBeenLastCalledWith(45, 15);
  });
});

describe('Derived', () => {
  let a: Store<number>;
  let b: Store<number>;

  beforeEach(() => {
    a = new Store(1);
    b = new Store(2);
  });

  it('computes initial state from deps and exposes it', () => {
    const d = new Derived<number, [Store<number>, Store<number>]>({
      deps: [a, b],
      fn: ({ currentDepVals }) => currentDepVals[0] + currentDepVals[1],
    });
    expect(d.getState()).toBe(3);
  });

  it('notifies subscribers when any dep changes (single dep change)', () => {
    const d = new Derived<number, [Store<number>, Store<number>]>({
      deps: [a, b],
      fn: ({ prevVal, currentDepVals }) => {
        const sum = currentDepVals[0] + currentDepVals[1];
        return prevVal === undefined ? sum : sum; // simple sum
      },
    });

    const listener = vi.fn();
    d.subscribe(listener, { greedy: true });
    const unmount = d.mount();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(3, 3);

    a.setState(5); // now 5 + 2 = 7
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(7, 3);
    expect(d.getState()).toBe(7);

    unmount(); // stop further notifications
    b.setState(10);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('passes correct prevVal, currentDepVals, and prevDepVals', () => {
    const spy = vi.fn(
      ({
        prevVal,
        currentDepVals,
        prevDepVals,
      }: {
        prevVal: number | undefined;
        currentDepVals: [number, number];
        prevDepVals: [number, number];
      }) => {
        console.log('prevVal: ', prevVal);
        console.log('prevDepVals: ', prevDepVals);
        console.log('currentDepVals[0]: ', currentDepVals[0]);
        console.log('currentDepVals[1]: ', currentDepVals[1]);
        return currentDepVals[0] * 10 + currentDepVals[1];
      },
    );
    const d = new Derived<number, [Store<number>, Store<number>]>({
      deps: [a, b],
      fn: spy,
    });

    // Initial compute happens in constructor; prevVal is undefined and prev/current dep vals are initial
    expect(d.getState()).toBe(12);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].prevVal).toBeUndefined();
    expect(spy.mock.calls[0][0].currentDepVals).toEqual([1, 2]);
    expect(spy.mock.calls[0][0].prevDepVals).toEqual([1, 2]);

    const unmount = d.mount();

    // Change only second dep (b)
    b.setState(9);
    // The derived fn should have been called again via mount subscription
    expect(spy).toHaveBeenCalledTimes(2);
    const { prevVal, currentDepVals, prevDepVals } = spy.mock.calls[1][0];
    expect(prevVal).toBe(12); // previous derived value
    expect(currentDepVals).toEqual([1, 9]); // current for all deps; changed dep has new value
    expect(prevDepVals).toEqual([1, 2]); // implementation mirrors getState() for unchanged deps
    // listener flow check
    const listener = vi.fn();
    d.subscribe(listener);
    a.setState(4); // now current [4,9] -> 49
    expect(d.getState()).toBe(49);
    expect(listener).toHaveBeenCalledWith(49, 19);

    unmount();
  });

  it('cleanup from mount unsubscribes all and clears internal sets', () => {
    const d = new Derived<number, [Store<number>, Store<number>]>({
      deps: [a, b],
      fn: ({ currentDepVals }) => currentDepVals[0] + currentDepVals[1],
    });
    const unsubListener = d.subscribe(vi.fn());
    const stop = d.mount();
    expect(typeof stop).toBe('function');

    stop(); // should unsubscribe internal subs and clear listeners
    unsubListener(); // calling after stop should be safe
    // After cleanup, further changes should not crash nor notify
    a.setState(100);
    b.setState(200);
    expect(d.getState()).toBe(3); // last computed value was initial (no listeners to change it post-unmount)
  });
});

describe('Effect', () => {
  it('mount subscribes to deps and runs fn on change; eager controls initial run', () => {
    const a = new Store(1);
    const b = new Store(2);
    const fn = vi.fn();

    // not eager
    const e1 = new Effect({ deps: [a, b], fn, eager: false });
    const stop1 = e1.mount();
    expect(fn).not.toHaveBeenCalled();

    a.setState(10);
    b.setState(20);
    expect(fn).toHaveBeenCalledTimes(2);

    stop1();

    // eager
    fn.mockClear();
    const e2 = new Effect({ deps: [a, b], fn, eager: true });
    const stop2 = e2.mount();
    expect(fn).toHaveBeenCalledTimes(1); // eager initial run
    a.setState(100);
    expect(fn).toHaveBeenCalledTimes(2);
    stop2();
  });
});
