const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDatabase } = require('../scripts/test-integration');

const local = { DB_HOST: '127.0.0.1', DB_NAME: 'freevoices_test', DB_USER: 'test', DB_PASSWORD: '', NODE_ENV: 'test' };
test('integration runner accepts only explicit local test databases', () => {
  assert.doesNotThrow(() => validateDatabase(local));
  assert.doesNotThrow(() => validateDatabase({ ...local, DB_NAME: 'freevoices_test_local_1' }));
  for (const invalid of [
    { DB_HOST: 'database.example.com' }, { DB_NAME: 'freevoices_dev' }, { DB_NAME: 'freevoices' },
    { DB_NAME: undefined }, { DB_USER: '' }, { DB_PASSWORD: undefined }, { NODE_ENV: 'production' },
  ]) assert.throws(() => validateDatabase({ ...local, ...invalid }));
});
