import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const readRepoFile = (relativePath) =>
  readFileSync(path.join(repoRoot, relativePath), 'utf8');

test('inventory skeleton uses dedicated service metadata and offline ports', () => {
  const packageJson = JSON.parse(readRepoFile('package.json'));
  const serverlessConfig = readRepoFile('serverless.yml');

  assert.equal(packageJson.name, 'inventory');
  assert.match(serverlessConfig, /^app:\s*inventory$/m);
  assert.match(serverlessConfig, /^service:\s*inventory$/m);
  assert.match(serverlessConfig, /^\s+versionFunctions:\s*false$/m);
  assert.match(serverlessConfig, /^  inventoryRuntimeByStage:/m);
  assert.match(serverlessConfig, /^\s+httpPort:\s*3022$/m);
  assert.match(serverlessConfig, /^\s+lambdaPort:\s*3032$/m);
});

test('inventory packages functions individually and excludes source maps', () => {
  const serverlessConfig = readRepoFile('serverless.yml');

  assert.match(serverlessConfig, /^package:\s*$/m);
  assert.match(serverlessConfig, /^\s+individually:\s*true$/m);
  assert.match(serverlessConfig, /^\s+- "!?\*\*\/\*\.map"$/m);
});

test('inventory runtime is narrowed to the inventory baseline', () => {
  const localRuntime = readRepoFile('serverless.runtime.local.yml');

  assert.match(localRuntime, /^OIDC_REALM:/m);
  assert.match(localRuntime, /^DATABASE_URL:/m);
  assert.match(localRuntime, /^PRIVATE_BUCKET_NAME:/m);
  assert.match(localRuntime, /^OFFERS_STOCK_SYNC_QUEUE_URL:/m);
  assert.match(localRuntime, /^OFFERS_STOCK_SYNC_QUEUE_ARN:/m);
  assert.match(localRuntime, /^CACHE_REDIS_URL:/m);
  assert.match(localRuntime, /^CACHE_REDIS_KEY_PREFIX:/m);
  assert.match(localRuntime, /^SERVICE_ENCRYPTION_KEY:/m);
  assert.match(localRuntime, /^CELLIFI_AWS_REGION:/m);
  assert.match(localRuntime, /^S3_ENDPOINT:/m);
  assert.match(localRuntime, /^AWS_ENDPOINT_URL:/m);
  assert.match(localRuntime, /^CELLIFI_AWS_ACCESS_KEY_ID:/m);
  assert.match(localRuntime, /^CELLIFI_AWS_SECRET_ACCESS_KEY:/m);
  assert.match(localRuntime, /^CLOUDFRONT_DOMAIN:/m);
  assert.match(localRuntime, /^AUTH_SHARED_AUTHORIZER_ARN:/m);
  assert.doesNotMatch(localRuntime, /OUTBOUND_PUBLICATIONS_QUEUE_URL/);
});

test('inventory cloud runtime includes S3 permissions required by blob handlers', () => {
  const serverlessConfig = readRepoFile('serverless.yml');

  assert.match(serverlessConfig, /^  iam:\s*$/m);
  assert.match(serverlessConfig, /^\s+role:\s*$/m);
  assert.match(serverlessConfig, /^\s+statements:\s*$/m);
  assert.match(serverlessConfig, /-\s*"s3:PutObject"/);
  assert.match(serverlessConfig, /-\s*"s3:GetObject"/);
  assert.match(serverlessConfig, /-\s*"s3:DeleteObject"/);
  assert.match(serverlessConfig, /-\s*"s3:ListBucket"/);
  assert.match(serverlessConfig, /-\s*"s3:HeadObject"/);
  assert.match(serverlessConfig, /arn:aws:s3:::\$\{self:custom\.inventoryRuntimeByStage\.PRIVATE_BUCKET_NAME\}/);
  assert.match(serverlessConfig, /arn:aws:s3:::\$\{self:custom\.inventoryRuntimeByStage\.PRIVATE_BUCKET_NAME\}\/\*/);
  assert.match(serverlessConfig, /-\s*"sqs:SendMessage"/);
  assert.match(serverlessConfig, /\$\{self:custom\.inventoryRuntimeByStage\.OFFERS_STOCK_SYNC_QUEUE_ARN\}/);
});
