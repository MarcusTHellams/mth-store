import { dequal } from 'dequal';
import * as S from './signal';

// Wrapper-based approach: create a computed via the normal `computed()` export and
// wrap it with a writable layer that stores a manual override and enqueues the
// underlying computed into the library flush pipeline by calling `__flush`.

export type WritableComputed<T> = S.Computed<T> & {
  // setter to write a manual override
  set value(v: T);
  // reset manual override
  resetOverride(): void;
};

type InternalComputed<T> = S.Computed<T> & {
  prevValue?: T;
  peek: () => T;
  recompute: () => void;
  registerOnGraph?: () => void;
  __isWritable?: boolean;
  resetOverride?: () => void;
};

export function computedWritable<T>(fn: () => T) {
  // create the base computed using existing API
  const base = S.computed(fn) as InternalComputed<T>;

  // attach an override slot and flag
  let hasOverride = false;
  let overrideValue: T | undefined;

  // wrap original recompute so that dependency-triggered recompute clears override
  const originalRecompute = base.recompute.bind(base);
  base.recompute = () => {
    if (hasOverride) {
      hasOverride = false;
      overrideValue = undefined;
    }
    originalRecompute();
  };

  // replace peek to consider override
  const originalPeek = base.peek.bind(base);
  base.peek = () => (hasOverride ? (overrideValue as T) : originalPeek());

  // define getter/setter pair on the computed instance for `value`
  Object.defineProperty(base, 'value', {
    configurable: true,
    enumerable: true,
    get: () => (hasOverride ? (overrideValue as T) : base.peek()),
    set: (v: T) => {
      // short circuit if same effective value
      if (dequal(v, base.peek())) return;
      base.prevValue = base.peek();
      hasOverride = true;
      overrideValue = v;
      // enqueue this computed into the flush system so it participates in batches
      S.__flush(base as unknown as S.Computed<T>);
    },
  });

  // helper method to reset the override manually
  base.resetOverride = () => {
    hasOverride = false;
    overrideValue = undefined;
  };

  base.__isWritable = true;

  return base as WritableComputed<T>;
}

