import { Derived } from './derived';
import { Effect } from './effect';
import { batch } from './scheduler';
import { Store } from './store';

export * from './derived';
export * from './effect';
export * from './store';
export { batch } from './scheduler';

const store1 = new Store(1);
const store2 = new Store(2);

const computed = new Derived({
  deps: [store1, store2],
  fn() {
    return store1.state + store2.state;
  },
});

const effect = new Effect({
  deps: [store1, store2, computed],
  fn() {
    console.log(`1: ${store1.state}, 2: ${store2.state} 3 Derived: ${computed.state}`);
  },
  eager: true,
});

computed.mount();
effect.mount();
batch(() => {
  store1.setState(3);
  store2.setState(4);
});
