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

test('inventory commits scoped env files for every supported environment', () => {
  const envLocal = readRepoFile('.env.local');
  const envTest = readRepoFile('.env.test');
  const envDevelopment = readRepoFile('.env.development');
  const envProduction = readRepoFile('.env.production');

  assert.match(
    envLocal,
    /^INVENTORY_DATABASE_URL=postgresql:\/\/inventory_user:inventory_password@localhost:5432\/inventory_local$/m,
  );
  assert.match(envTest, /^CACHE_REDIS_URL=redis:\/\/localhost:6380$/m);
  assert.match(envTest, /^INVENTORY_AWS_ENDPOINT_URL=http:\/\/localhost:4566$/m);
  assert.match(envTest, /^MP_FE_URL=http:\/\/localhost:3001$/m);
  assert.match(
    envTest,
    /^AUTH_SHARED_AUTHORIZER_ARN=arn:aws:lambda:us-east-1:975049995405:function:cellifi-auth-local-authorizer$/m,
  );

  assert.match(envDevelopment, /^OIDC_REALM=\/cellifi\/dev\/inventory\/runtime\/oidc-realm$/m);
  assert.match(
    envDevelopment,
    /^DATABASE_URL=\/aws\/reference\/secretsmanager\/cellifi\/dev\/inventory\/runtime:database_url$/m,
  );
  assert.match(
    envDevelopment,
    /^INVENTORY_DATABASE_URL=\/aws\/reference\/secretsmanager\/cellifi\/dev\/inventory\/runtime:database_url$/m,
  );
  assert.match(
    envDevelopment,
    /^PRIVATE_BUCKET_NAME=\/cellifi\/dev\/inventory\/runtime\/private-bucket-name$/m,
  );
  assert.match(
    envDevelopment,
    /^OFFERS_STOCK_SYNC_QUEUE_URL=\/cellifi\/dev\/inventory\/runtime\/offers-stock-sync-queue-url$/m,
  );
  assert.match(
    envDevelopment,
    /^OFFERS_STOCK_SYNC_QUEUE_ARN=\/cellifi\/dev\/inventory\/runtime\/offers-stock-sync-queue-arn$/m,
  );
  assert.match(
    envDevelopment,
    /^CACHE_REDIS_URL=\/aws\/reference\/secretsmanager\/cellifi\/dev\/inventory\/runtime:cache_redis_url$/m,
  );
  assert.match(
    envDevelopment,
    /^CACHE_REDIS_KEY_PREFIX=\/aws\/reference\/secretsmanager\/cellifi\/dev\/inventory\/runtime:cache_redis_key_prefix$/m,
  );
  assert.match(
    envDevelopment,
    /^SERVICE_ENCRYPTION_KEY=\/aws\/reference\/secretsmanager\/cellifi\/dev\/inventory\/runtime:service_encryption_key$/m,
  );
  assert.match(
    envDevelopment,
    /^GOOGLE_MAPS_API_KEY=\/aws\/reference\/secretsmanager\/cellifi\/dev\/inventory\/runtime:google_maps_api_key$/m,
  );
  assert.match(
    envDevelopment,
    /^CLOUDFRONT_DOMAIN=\/cellifi\/dev\/inventory\/runtime\/cloudfront-domain$/m,
  );
  assert.match(envDevelopment, /^MP_FE_URL=\/cellifi\/dev\/inventory\/runtime\/mp-fe-url$/m);
  assert.match(
    envDevelopment,
    /^AUTH_SHARED_AUTHORIZER_ARN=\/cellifi\/dev\/inventory\/runtime\/auth-shared-authorizer-arn$/m,
  );

  assert.match(envProduction, /^OIDC_REALM=\/cellifi\/prod\/inventory\/runtime\/oidc-realm$/m);
  assert.match(
    envProduction,
    /^DATABASE_URL=\/aws\/reference\/secretsmanager\/cellifi\/prod\/inventory\/runtime:database_url$/m,
  );
  assert.match(
    envProduction,
    /^INVENTORY_DATABASE_URL=\/aws\/reference\/secretsmanager\/cellifi\/prod\/inventory\/runtime:database_url$/m,
  );
  assert.match(
    envProduction,
    /^PRIVATE_BUCKET_NAME=\/cellifi\/prod\/inventory\/runtime\/private-bucket-name$/m,
  );
  assert.match(
    envProduction,
    /^OFFERS_STOCK_SYNC_QUEUE_URL=\/cellifi\/prod\/inventory\/runtime\/offers-stock-sync-queue-url$/m,
  );
  assert.match(
    envProduction,
    /^OFFERS_STOCK_SYNC_QUEUE_ARN=\/cellifi\/prod\/inventory\/runtime\/offers-stock-sync-queue-arn$/m,
  );
  assert.match(
    envProduction,
    /^CACHE_REDIS_URL=\/aws\/reference\/secretsmanager\/cellifi\/prod\/inventory\/runtime:cache_redis_url$/m,
  );
  assert.match(
    envProduction,
    /^CACHE_REDIS_KEY_PREFIX=\/aws\/reference\/secretsmanager\/cellifi\/prod\/inventory\/runtime:cache_redis_key_prefix$/m,
  );
  assert.match(
    envProduction,
    /^SERVICE_ENCRYPTION_KEY=\/aws\/reference\/secretsmanager\/cellifi\/prod\/inventory\/runtime:service_encryption_key$/m,
  );
  assert.match(
    envProduction,
    /^GOOGLE_MAPS_API_KEY=\/aws\/reference\/secretsmanager\/cellifi\/prod\/inventory\/runtime:google_maps_api_key$/m,
  );
  assert.match(
    envProduction,
    /^CLOUDFRONT_DOMAIN=\/cellifi\/prod\/inventory\/runtime\/cloudfront-domain$/m,
  );
  assert.match(envProduction, /^MP_FE_URL=\/cellifi\/prod\/inventory\/runtime\/mp-fe-url$/m);
  assert.match(
    envProduction,
    /^AUTH_SHARED_AUTHORIZER_ARN=\/cellifi\/prod\/inventory\/runtime\/auth-shared-authorizer-arn$/m,
  );
});
