import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const readRepoFile = (relativePath) =>
  readFileSync(path.join(repoRoot, relativePath), 'utf8');

test('inventory object storage helper uses AWS SDK v3 S3 modules', () => {
  const source = readRepoFile('src/lib/objectStorage.ts');

  assert.doesNotMatch(source, /from ['"]aws-sdk['"]/);
  assert.match(source, /@aws-sdk\/client-s3/);
  assert.match(source, /@aws-sdk\/s3-request-presigner/);
});

test('inventory package declares patched serverless and v3 object storage packages', () => {
  const packageJson = JSON.parse(readRepoFile('package.json'));

  assert.equal(packageJson.dependencies?.['aws-sdk'], undefined);
  assert.equal(packageJson.dependencies?.['@aws-sdk/client-s3'], '^3.927.0');
  assert.equal(packageJson.dependencies?.['@aws-sdk/s3-request-presigner'], '^3.927.0');
  assert.equal(packageJson.devDependencies?.serverless, '^4.38.1');
});
