import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const readRepoFile = (relativePath) =>
  readFileSync(path.join(repoRoot, relativePath), 'utf8');

test('inventory local and test database contract includes bootstrap scripts and extracted migrations', () => {
  const packageJson = JSON.parse(readRepoFile('package.json'));
  const envLocal = readRepoFile('.env.local');
  const envTest = readRepoFile('.env.test');
  const migrationsDir = path.join(repoRoot, 'prisma', 'migrations');
  const migrationNames = existsSync(migrationsDir)
    ? readdirSync(migrationsDir).filter((entry) =>
        existsSync(path.join(migrationsDir, entry, 'migration.sql'))
      )
    : [];

  assert.equal(
    packageJson.scripts['local:db:setup'],
    'bash scripts/setup-local-db.sh'
  );
  assert.equal(
    packageJson.scripts['test:db:setup'],
    'bash scripts/setup-test-db.sh'
  );
  assert.match(
    packageJson.scripts['prisma:migrate:deploy'],
    /prisma migrate deploy --schema=prisma\/schema\.prisma/
  );
  assert.match(envLocal, /^DATABASE_URL=postgresql:\/\/inventory_user:inventory_password@localhost:5432\/inventory_local$/m);
  assert.match(envTest, /^DATABASE_URL=postgresql:\/\/inventory_test:test_password_local@localhost:5432\/inventory_test$/m);
  assert.equal(existsSync(path.join(repoRoot, 'scripts', 'setup-local-db.sh')), true);
  assert.equal(existsSync(path.join(repoRoot, 'scripts', 'setup-test-db.sh')), true);
  assert.equal(
    existsSync(path.join(repoRoot, 'prisma', 'migrations', 'migration_lock.toml')),
    true
  );
  assert.deepEqual(migrationNames, [
    '20260525221500_inventory_split_baseline',
    '20260610100000_add_blob_asset_ref',
    '20260611231500_allow_duplicate_blob_keys',
    '20260803183000_add_released_movement_reason',
    '20260911201348_reservation_payment_protection',
    '20260911202504_reservation_operation_input',
    '20260911203030_enforce_inventory_lineage_foreign_keys',
    '20260911204037_inventory_command_inbox_result_outbox',
    '20260911205132_inventory_result_receipt_deliveries',
    '20260911205315_inventory_workflow_absolute_timestamps',
    '20260911214501_inventory_assigned_command_recovery',
  ]);
});
