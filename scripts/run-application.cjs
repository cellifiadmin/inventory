const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const dotenv = require('dotenv');

const ERROR = 'Explicit nonowner Inventory application database configuration is required';
const LIBPQ = new Set(['PGPASSWORD', 'PGPASSFILE', 'PGSERVICE', 'PGSERVICEFILE', 'PGUSER',
  'PGDATABASE', 'PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGOPTIONS']);

function prepareApplicationEnvironment(stage, environment, root, readFile = fs.readFileSync) {
  try {
    if (!['local', 'test'].includes(stage)) throw new Error();
    const url = environment.INVENTORY_DATABASE_URL ??
      dotenv.parse(readFile(path.join(root, `.env.database.${stage}`))).INVENTORY_DATABASE_URL;
    const target = new URL(url);
    if (target.protocol !== 'postgresql:' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ||
      target.pathname !== `/inventory_${stage}` ||
      decodeURIComponent(target.username) !== (stage === 'test' ? 'inventory_test_runtime' : 'inventory_runtime') ||
      !target.password || target.search || target.hash) throw new Error();
    const env = Object.fromEntries(Object.entries(environment).filter(([key]) =>
      key !== 'DATABASE_URL' && !key.endsWith('_DATABASE_URL') &&
      key !== 'POSTGRES_ADMIN_URL' && !key.endsWith('_POSTGRES_ADMIN_URL') && !LIBPQ.has(key)));
    return { ...env, INVENTORY_DATABASE_URL: url };
  } catch {
    throw new Error(ERROR);
  }
}

function launchApplication(stage, args, environment = process.env, dependencies = {}) {
  const env = prepareApplicationEnvironment(stage, environment, path.resolve(__dirname, '..'), dependencies.readFile);
  const child = (dependencies.spawn || spawn)('python3', args, { env, stdio: 'inherit' });
  const interrupt = signal => child.kill(signal);
  const sigint = () => interrupt('SIGINT');
  const sigterm = () => interrupt('SIGTERM');
  process.once('SIGINT', sigint);
  process.once('SIGTERM', sigterm);
  return new Promise((resolve, reject) => {
    let failed = false;
    child.once('error', () => { failed = true; });
    child.once('close', (code, signal) => {
      process.removeListener('SIGINT', sigint);
      process.removeListener('SIGTERM', sigterm);
      if (failed || signal || code !== 0) reject(new Error('Inventory application process failed'));
      else resolve();
    });
  });
}

if (require.main === module) {
  Promise.resolve().then(() => launchApplication(process.argv[2], process.argv.slice(3))).catch(() => {
    process.stderr.write(`${ERROR}\n`);
    process.exitCode = 1;
  });
}
module.exports = { prepareApplicationEnvironment, launchApplication };
