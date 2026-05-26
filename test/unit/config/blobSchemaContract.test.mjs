import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const schema = readFileSync(path.join(repoRoot, 'prisma/schema.prisma'), 'utf8');
const migration = readFileSync(
  path.join(
    repoRoot,
    'prisma/migrations/20260611231500_allow_duplicate_blob_keys/migration.sql',
  ),
  'utf8',
);

test('inventory blob schema keeps assetRef unique but allows duplicate physical keys', () => {
  assert.match(
    schema,
    /model Blob[\s\S]*key\s+String\s+@inventoryDb\.VarChar\(255\)/m,
  );
  assert.doesNotMatch(
    schema,
    /model Blob[\s\S]*key\s+String\s+@unique/m,
  );
  assert.match(
    schema,
    /assetRef\s+String\?\s+@unique\s+@map\("asset_ref"\)/m,
  );
});

test('inventory migration drops the legacy unique index on blob keys', () => {
  assert.match(migration, /DROP INDEX IF EXISTS "blobs_key_key";/);
});
