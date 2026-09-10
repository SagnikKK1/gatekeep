import { test } from 'node:test';
import assert from 'node:assert/strict';
import { count } from '../src/count.js';

test('count returns the length', () => {
  assert.equal(count(['a', 'b']), 2);
});
