import { Derived } from './derived';
import { Effect } from './effect';
import { batch } from './scheduler';
import { Store } from './store';

export * from './derived';
export * from './effect';
export * from './store';
export { batch } from './scheduler';

const store1 = new Store(1);
const store2 = new Store(3);

const computed = new Derived({
  deps: [store1, store2],
  fn() {
    return store1.state * store2.state;
  },
});

const effect = new Effect({
  deps: [computed],
  fn() {
    console.log('computed: ', computed.state);
  },
  eager: true,
});

computed.mount();
effect.mount();
store1.setState(25);
store2.setState(100);
store1.setState(150);

