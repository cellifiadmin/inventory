import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const readRepoFile = (relativePath) =>
  readFileSync(path.join(repoRoot, relativePath), 'utf8');

test('inventory local/test env defines a resolvable public base url separate from the raw S3 endpoint', () => {
  const envLocal = readRepoFile('.env.local');
  const envTest = readRepoFile('.env.test');

  assert.match(
    envLocal,
    /^OBJECT_STORAGE_PUBLIC_BASE_URL=http:\/\/cdn\.localhost\.localstack\.cloud:4566\/cellifi-local$/m
  );
  assert.match(
    envTest,
    /^OBJECT_STORAGE_PUBLIC_BASE_URL=http:\/\/cdn\.localhost\.localstack\.cloud:4566\/cellifi-test$/m
  );
});

test('inventory local/test runtimes inject the public base url used for published image urls', () => {
  const serverlessConfig = readRepoFile('serverless.yml');
  const localRuntime = readRepoFile('serverless.runtime.local.yml');

  assert.match(
    serverlessConfig,
    /^\s+OBJECT_STORAGE_PUBLIC_BASE_URL: \$\{self:custom\.inventoryRuntimeByStage\.OBJECT_STORAGE_PUBLIC_BASE_URL\}$/m
  );
  assert.match(
    localRuntime,
    /^OBJECT_STORAGE_PUBLIC_BASE_URL: \$\{env:OBJECT_STORAGE_PUBLIC_BASE_URL\}$/m
  );
});
