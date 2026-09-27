const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareApplicationEnvironment } = require('../../../scripts/run-application.cjs');

const runtime = 'postgresql://inventory_test_runtime:synthetic@localhost:5432/inventory_test';
const owner = 'postgresql://inventory_test:synthetic@localhost:5432/inventory_test';

test('Inventory runtime drops owner, cross-service and libpq credentials', () => {
  assert.deepEqual(prepareApplicationEnvironment('test', {
    INVENTORY_DATABASE_URL: runtime,
    DATABASE_URL: owner,
    INVENTORY_MIGRATION_DATABASE_URL: owner,
    FULFILLMENT_DATABASE_URL: owner,
    PGUSER: 'inventory_test',
    OTHER: 'keep',
  }, '/task'), { INVENTORY_DATABASE_URL: runtime, OTHER: 'keep' });
});

test('Inventory stage bootstrap accepts only a separate runtime login', () => {
  assert.deepEqual(prepareApplicationEnvironment('test', {}, '/task', file => {
    assert.equal(file, '/task/.env.database.test');
    return `INVENTORY_MIGRATION_DATABASE_URL=${owner}\nINVENTORY_DATABASE_URL=${runtime}`;
  }), { INVENTORY_DATABASE_URL: runtime });
});

for (const candidate of [owner, '', runtime.replace('localhost', 'remote'),
  runtime.replace('/inventory_test', '/inventory_local'), runtime.replace(':synthetic', ''),
  runtime + '?schema=other'])
  test('Inventory owner or ambiguous application URL is rejected without disclosure', () => {
    assert.throws(() => prepareApplicationEnvironment('test', { INVENTORY_DATABASE_URL: candidate }, '/task'),
      { message: 'Explicit nonowner Inventory application database configuration is required' });
  });
