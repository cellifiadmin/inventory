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
const packageJson = JSON.parse(
  readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
);
const readme = readFileSync(
  path.join(repoRoot, 'README.md'),
  'utf8',
);

test('inventory serverless package includes the linux Prisma engine for inventoryClient', () => {
  assert.match(
    serverlessConfig,
    /node_modules\/\.prisma\/inventoryClient\/libquery_engine-rhel-openssl-3\.0\.x\.so\.node/
  );
  assert.match(
    serverlessConfig,
    /node_modules\/\.prisma\/inventoryClient\/schema\.prisma/
  );
  assert.match(
    serverlessConfig,
    /node_modules\/@prisma\/client\/\*\*/
  );
});

test('inventory packaging scripts keep linux sharp binaries available for Lambda packaging', () => {
  assert.equal(typeof packageJson.dependencies.sharp, 'string');
  assert.ok(packageJson.dependencies.sharp.length > 0);
  assert.equal(
    packageJson.scripts['ensure:sharp:lambda'],
    'npm install --no-save --os=linux --cpu=x64 --libc=glibc sharp',
  );
  assert.equal(
    packageJson.scripts['prepackage:local'],
    'npm run ensure:sharp:lambda',
  );
  assert.equal(
    packageJson.scripts['predeploy:dev'],
    'npm run ensure:sharp:lambda',
  );
  assert.equal(
    packageJson.scripts['predeploy:prod'],
    'npm run ensure:sharp:lambda',
  );
});

test('inventory README points local packaging verification at the npm wrapper', () => {
  assert.match(readme, /`npm run package:local` passes/);
  assert.doesNotMatch(readme, /`serverless package --stage local` passes/);
});
