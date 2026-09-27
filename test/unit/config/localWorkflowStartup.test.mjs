import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const service = 'inventory';
const wrapper = path.join(repoRoot, 'scripts/run-local-workflow.sh');

function invokeWrapper(overrides, forwarded, expectedStatus = 0) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'cellifi-startup-'));
  try {
    writeFileSync(path.join(directory, 'python3'), `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n`, { mode: 0o755 });
    const environment = { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}` };
    delete environment.CELLIFI_LOCAL_STAGE;
    delete environment.CELLIFI_INFRASTRUCTURE_ROOT;
    delete environment.CELLIFI_LOCAL_WORKFLOW_RUNTIME_FILE;
    Object.assign(environment, overrides);
    const stage = environment.CELLIFI_LOCAL_STAGE === 'test' ? 'test' : 'local';
    environment.INVENTORY_DATABASE_URL = `postgresql://${stage === 'test' ? 'inventory_test_runtime' : 'inventory_runtime'}:synthetic@localhost:5432/inventory_${stage}`;
    const result = spawnSync('bash', [wrapper, ...forwarded], { cwd: directory, env: environment, encoding: 'utf8' });
    assert.equal(result.status, expectedStatus, result.stderr);
    return expectedStatus === 0 ? JSON.parse(result.stdout) : result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('dev and local enter the canonical workflow launcher before Serverless', () => {
  const scripts = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts.dev, 'bash scripts/run-local-workflow.sh');
  assert.equal(scripts.local, scripts.dev);
  assert.equal(scripts.predev, undefined);
});

test('the wrapper resolves sibling defaults and preserves forwarded argument boundaries', () => {
  const forwarded = ['--httpPort', '9999', ';literal', '$(literal)', 'argument with spaces'];
  const result = invokeWrapper({}, forwarded);
  assert.equal(result.cwd, repoRoot);
  assert.deepEqual(result.argv, [
    `${repoRoot}/../infrastructure/scripts/run-local-workflow-service.py`,
    '--service', service, '--stage', 'local',
    '--runtime-file', `${repoRoot}/../.local/workflows/local.json`, '--',
    `${repoRoot}/node_modules/.bin/serverless`, 'offline', 'start', '--stage', 'local', ...forwarded,
  ]);
});

test('the wrapper accepts explicit worktree infrastructure and runtime paths', () => {
  const infrastructure = '/tmp/infra checkout';
  const runtime = '/tmp/runtime directory/local.json';
  const result = invokeWrapper({ CELLIFI_INFRASTRUCTURE_ROOT: infrastructure, CELLIFI_LOCAL_WORKFLOW_RUNTIME_FILE: runtime }, []);
  assert.equal(result.argv[0], `${infrastructure}/scripts/run-local-workflow-service.py`);
  assert.equal(result.argv[result.argv.indexOf('--runtime-file') + 1], runtime);
  assert.equal(result.argv[result.argv.indexOf('--service') + 1], service);
  assert.equal(result.cwd, repoRoot);
});


test('the test resource namespace selects its artifact while Serverless uses direct local configuration', () => {
  const result = invokeWrapper({ CELLIFI_LOCAL_STAGE: 'test' }, ['--httpPort', '9999']);
  assert.equal(result.argv[result.argv.indexOf('--runtime-file') + 1], `${repoRoot}/../.local/workflows/test.json`);
  const stages = result.argv.flatMap((argument, index) => argument === '--stage' ? [result.argv[index + 1]] : []);
  assert.deepEqual(stages, ['test', 'local']);
  const localRuntime = readFileSync(path.join(repoRoot, 'serverless.runtime.local.yml'), 'utf8');
  assert.match(localRuntime, /^DATABASE_URL: \$\{env:INVENTORY_DATABASE_URL\}$/m);
  assert.doesNotMatch(localRuntime, /\$\{ssm:/);
});

test('unsupported environment stages fail before launching the service', () => {
  for (const stage of ['development', 'production', 'LOCAL']) {
    const result = invokeWrapper({ CELLIFI_LOCAL_STAGE: stage }, [], 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /CELLIFI_LOCAL_STAGE.*local.*test/);
  }
});

test('forwarded stage flags cannot replace the validated artifact stage', () => {
  for (const forwarded of [['--stage', 'test'], ['--stage=test'], ['-s', 'test'], ['-stest'], ['-s=test']]) {
    const result = invokeWrapper({}, forwarded, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /CELLIFI_LOCAL_STAGE/);
  }
});
