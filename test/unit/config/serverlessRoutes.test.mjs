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
  expectRoute('/stock/reserve', 'post');
  expectRoute('/stock/commit', 'post');
  expectRoute('/stock/release', 'post');
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
