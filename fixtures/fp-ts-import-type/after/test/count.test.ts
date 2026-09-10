import { test } from 'node:test';
import assert from 'node:assert/strict';
import { count } from '../src/count.js';

let entries: import('node:fs').Dirent[] = [];
let obs: import('rxjs').Observable<number>;

test('count returns the length', () => {
  assert.equal(count(['a', 'b']), 2);
});

test('count handles dirents', () => {
  assert.equal(count(entries), 0);
});
