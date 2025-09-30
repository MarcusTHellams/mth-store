import { __flush } from './scheduler';
import { AnyUpdater, isUpdaterFunction, Listener, Updater } from './types';

export interface StoreOptions<State, Updater extends AnyUpdater = (cb: State) => State> {
  /**
   * Replace the default update function with a custom one.
   */
  updateFn?: (previous: State) => (updater: Updater) => State;
  /**
   * Called when a listener subscribes to the store.
   *
   * @return a function to unsubscribe the listener
   */
  onSubscribe?: (listener: Listener<State>, store: Store<State, Updater>) => () => void;
  /**
   * Called after the state has been updated, used to derive other state.
   */
  onUpdate?: () => void;
}

export class Store<State, TUpdater extends AnyUpdater = (cb: State) => State> {
  listeners = new Set<Listener<State>>();
  state: State;
  prevState: State;
  options?: StoreOptions<State>;
  constructor(initialState: State, options?: StoreOptions<State>) {
    this.state = initialState;
    this.prevState = initialState;
    this.options = options;
  }
  subscribe = (listener: Listener<State>) => {
    this.listeners.add(listener);
    const unsub = this.options?.onSubscribe?.(listener, this);
    return () => {
      this.listeners.delete(listener);
      unsub?.();
    };
  };

  setState(updater: (prevState: State) => State): void;
  setState(updater: State): void;
  setState(updater: TUpdater): void;
  setState(updater: Updater<State> | TUpdater): void {
    this.prevState = this.state;
    if (this.options?.updateFn) {
      this.state = this.options.updateFn(this.prevState)(updater as TUpdater);
    } else {
      if (isUpdaterFunction(updater)) {
        this.state = updater(this.prevState);
      } else {
        this.state = updater as State;
      }
    }

    this.options?.onUpdate?.();
    __flush(this as never);
  }
}
