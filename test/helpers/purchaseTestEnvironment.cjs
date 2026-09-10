const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '../..');
const service = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name;
const databaseKey = `${service.toUpperCase()}_DATABASE_URL`;
const raw = process.env[databaseKey] || process.env.DATABASE_URL;
if (!raw) throw new Error(`Missing ${databaseKey} for purchase integration tests`);
const target = new URL(raw);
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
    || decodeURIComponent(target.pathname.slice(1)) !== `${service}_test`
    || decodeURIComponent(target.username) !== `${service}_test`) {
  throw new Error('Purchase integration tests require the isolated local service_test database and role');
}
// Prevent Prisma fallback from connecting to a different database.
process.env[databaseKey] = raw;
process.env.DATABASE_URL = raw;
