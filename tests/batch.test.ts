/* eslint-disable @typescript-eslint/no-explicit-any */
import { Store, Derived, Effect, batch } from '../src/store';

describe('Batching', () => {
  it('Effect runs once when multiple deps update inside a batch', () => {
    const a = new Store(1);
    const b = new Store(2);
    const effectFn = vi.fn();

    const effect = new Effect({ deps: [a, b], fn: effectFn, eager: false });
    const stop = effect.mount();

    batch(() => {
      a.setState(10);
      b.setState(20);
    });

    // Effect should run exactly once for the batch (two store updates)
    expect(effectFn).toHaveBeenCalledTimes(1);

    stop();
  });

  it('Derived notifies listeners once and final state is correct when multiple deps update inside a batch', () => {
    const a = new Store(1);
    const b = new Store(2);

    const d = new Derived<number, [Store<number>, Store<number>]>({
      deps: [a, b],
      fn: ({ currentDepVals }) => currentDepVals[0] + currentDepVals[1],
    });

    const listener = vi.fn();
    d.subscribe(listener);
    const stop = d.mount();

    batch(() => {
      a.setState(3); // a: 3
      b.setState(7); // b: 7
    });

    // Derived listener should have been called once (with new sum 10)
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(10, 3); // previous derived value was 3
    expect(d.getState()).toBe(10);

    stop();
  });
});
