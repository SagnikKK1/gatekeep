import { fetchIt } from '../src/api.js';

test('fetchIt returns 3', async () => {
  await expect(fetchIt()).resolves.toBe(3);
});
