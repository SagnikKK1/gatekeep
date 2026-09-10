import { test } from 'node:test';
import assert from 'node:assert/strict';
import { count } from '../src/count.js';

// An import type. Valid TypeScript that our grammar build cannot parse.
let entries: import('node:fs').Dirent[] = [];

test('count returns the length', () => {
  assert.equal(count(entries), 0);
  assert.equal(count(['a', 'b']), 2);
});
