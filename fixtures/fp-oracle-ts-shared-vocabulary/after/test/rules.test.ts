import { test } from 'node:test';
import assert from 'node:assert/strict';
import { familyOf } from '../src/rules.js';

test('families', () => {
  assert.equal(familyOf('test-deleted'), 'test integrity');
  assert.equal(familyOf('scope-protected'), 'scope');
});
