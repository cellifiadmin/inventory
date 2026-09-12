import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const serverlessConfig = readFileSync(
  path.join(repoRoot, 'serverless.yml'),
  'utf8',
);

const expectRoute = (routePath, method) => {
  assert.match(
    serverlessConfig,
    new RegExp(`path:\\s*${routePath.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}[\\s\\S]*?method:\\s*${method}`, 'm'),
  );
};

test('inventory exposes the extracted inventory API surface', () => {
  expectRoute('/inventory/media-grants', 'post');
  expectRoute('/inventory/items/{id}/edit', 'get');
  expectRoute('/inventory/items/{id}/images', 'get');
  expectRoute('/inventory/items/{id}/main-image', 'get');
  expectRoute('/inventory/items/{id}/attachments/cdn', 'get');
  expectRoute('/inventory/items/attachments/cdn', 'get');
  expectRoute('/inventory/items/{id}/movements', 'get');
  expectRoute('/inventory/items/{id}', 'put');
  expectRoute('/inventory/items', 'post');
  expectRoute('/inventories', 'post');
  expectRoute('/inventory/items/{id}', 'get');
  expectRoute('/inventory/items', 'get');
  expectRoute('/inventory/account-addresses', 'get');
  expectRoute('/inventory/account-addresses/{type}', 'put');
  expectRoute('/inventory/account-addresses/{type}', 'delete');
  expectRoute('/inventory/item-resolutions', 'post');
  expectRoute('/inventories/{id}/mark-as-sold', 'post');
});

test('inventory exposes the scheduled stock reservation sweeper', () => {
  assert.match(
    serverlessConfig,
    /expireStockReservations:[\s\S]*?handler:\s*src\/handlers\/scheduled\/stock-reservations\/expire\.handler/
  );
  assert.match(serverlessConfig, /schedule:/);
});

test('inventory serverless surface does not expose catalog or offers routes', () => {
  assert.doesNotMatch(serverlessConfig, /path:\s*\/catalog\//);
  assert.doesNotMatch(serverlessConfig, /path:\s*\/offers\//);
  assert.doesNotMatch(serverlessConfig, /path:\s*\/inventory\/blobs(?:\/|\s|$)/);
  assert.doesNotMatch(
    serverlessConfig,
    /path:\s*\/inventory\/attachments(?:\/\{id\}|(?!\/cdn))/,
  );
});

test('inventory defines the short internal approved-address sync function name', () => {
  assert.match(
    serverlessConfig,
    /name:\s*\$\{self:service\}-\$\{self:provider\.stage\}-sync-approved-addresses/
  );
  assert.doesNotMatch(serverlessConfig, /provision-approved-account-addresses/);
});


test('reservation mutations use one Standard SQS consumer and bounded scheduled delivery', () => {
  assert.match(serverlessConfig, /runtime: nodejs22.x/);
  const scripts = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts.dev, 'bash scripts/run-local-workflow.sh');
  assert.equal(scripts.local, 'bash scripts/run-local-workflow.sh');
  assert.equal((serverlessConfig.match(/rate: rate\(1 minute\)/g) || []).length, 3);
  assert.doesNotMatch(serverlessConfig, /path:\s*\/stock\//);
  assert.doesNotMatch(serverlessConfig, /INTERNAL_SERVICE_REQUEST_SIGNING_SECRET/);
  assert.match(serverlessConfig, /processReservationCommands:[\s\S]*?handler: src\/handlers\/sqs\/reservation-operations\/process.handler/);
  assert.equal((serverlessConfig.match(/functionResponseType: ReportBatchItemFailures/g) || []).length, 2);
  assert.match(serverlessConfig, /publishReservationResults:[\s\S]*?handler: src\/handlers\/scheduled\/reservation-results\/publish.handler/);
  assert.ok(serverlessConfig.indexOf('  - serverless-offline\n') < serverlessConfig.indexOf('  - serverless-offline-sqs'));
});

test('every stage has all twelve canonical workflow queue bindings', () => {
  const keys = ['COMMERCE_COMMAND_QUEUE_URL', 'COMMERCE_COMMAND_QUEUE_ARN', 'COMMERCE_COMMAND_QUEUE_DLQ_URL', 'COMMERCE_COMMAND_QUEUE_DLQ_ARN',
    'FULFILLMENT_COMMAND_QUEUE_URL', 'FULFILLMENT_COMMAND_QUEUE_ARN', 'FULFILLMENT_COMMAND_QUEUE_DLQ_URL', 'FULFILLMENT_COMMAND_QUEUE_DLQ_ARN',
    'COMMERCE_RESULT_QUEUE_URL', 'COMMERCE_RESULT_QUEUE_ARN', 'FULFILLMENT_RESULT_QUEUE_URL', 'FULFILLMENT_RESULT_QUEUE_ARN'];
  for (const stage of ['local', 'development', 'dev', 'test', 'production']) {
    const runtime = readFileSync(path.join(repoRoot, `serverless.runtime.${stage}.yml`), 'utf8');
    for (const key of keys) {
      assert.match(runtime, new RegExp(`^${key}:`, 'm'));
      assert.match(serverlessConfig, new RegExp(`^    ${key}:`, 'm'));
      if (stage !== 'local') {
        const workspace = stage === 'production' ? 'prod' : stage === 'test' ? 'test' : 'dev';
        assert.ok(runtime.includes(`/cellifi/${workspace}/inventory/runtime/${key.toLowerCase().replaceAll('_', '-')}`));
      }
    }
  }
});

test('owner expiry events have an independent bounded publisher on the existing owner result route', () => {
  assert.match(serverlessConfig, /publishReservationOwnerEvents:\n\s+handler: src\/handlers\/scheduled\/reservation-owner-events\/publish.handler\n\s+timeout: 60/);
});
