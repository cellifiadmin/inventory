const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const build = require('../../helpers/purchaseCoverageConfig.cjs');

function fixture(t, files, prefixes = ['src/']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purchase-coverage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries({
    'jest.config.js': 'module.exports = {};',
    'test/purchase-coverage-manifest.json': JSON.stringify({ sourcePrefixes: prefixes }),
    ...files,
  })) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  return root;
}

test('counts unimported executable modules and index exports at full thresholds', t => {
  const root = fixture(t, { 'src/unimported.ts': 'export const price = () => 100;', 'src/index.ts': 'export { price } from "./unimported";' });
  const result = build(root, 'unit');
  assert.deepEqual(result.collectCoverageFrom, ['src/index.ts', 'src/unimported.ts']);
  for (const entry of Object.values(result.coverageThreshold)) {
    assert.deepEqual(entry, { statements: 100, branches: 100, functions: 100, lines: 100 });
  }
});

test('excludes only nonexecutable type declarations and follows owned dependencies', t => {
  const root = fixture(t, {
    'src/domain/start.ts': 'import { amount } from "@/shared/amount"; export const total = amount;',
    'src/shared/amount.ts': 'export const amount = 100;',
    'src/domain/types.ts': 'export interface Input { amount: number }; export type Money = number;',
  }, ['src/domain/']);
  assert.deepEqual(build(root, 'unit').collectCoverageFrom, ['src/domain/start.ts', 'src/shared/amount.ts']);
});

test('keeps integration and provider suites separate from unit evidence', t => {
  const root = fixture(t, { 'src/payment.ts': 'export const payment = 1;' });
  const integration = build(root, 'integration');
  assert.deepEqual(integration.testMatch, ['<rootDir>/test/integration/**/*.test.ts']);
  assert.ok(integration.setupFiles[0].includes('purchaseTestEnvironment'));
  assert.equal(integration.coverageThreshold, undefined);
  assert.deepEqual(build(root, 'providers').testMatch, ['<rootDir>/test/providers/**/*.test.ts']);
});

test('rejects an empty source scope and an unknown suite', t => {
  const root = fixture(t, { 'src/domain.ts': 'export const value = 1;' });
  assert.throws(() => build(root, 'imaginary'), /Unsupported purchase test suite/);
  const empty = fixture(t, { 'src/outside.ts': 'export const value = 1;' }, ['src/missing/']);
  assert.throws(() => build(empty, 'unit'), /selected no source files/);
});
