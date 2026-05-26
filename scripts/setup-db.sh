#!/bin/bash
set -euo pipefail

ENV_FILE="${1:-}"

if [ -z "$ENV_FILE" ]; then
  echo "Usage: bash scripts/setup-db.sh .env.local|.env.test"
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ Environment file not found: $ENV_FILE"
  exit 1
fi

echo "🗄️  Setting up inventory database from $ENV_FILE..."

set -a
source "$ENV_FILE"
set +a

INVENTORY_DB_URL="${INVENTORY_DATABASE_URL:-${DATABASE_URL:-}}"
ADMIN_DB_URL="${INVENTORY_POSTGRES_ADMIN_URL:-postgresql://localhost:5432/postgres}"

if [ -z "$INVENTORY_DB_URL" ]; then
  echo "❌ INVENTORY_DATABASE_URL or DATABASE_URL must be set in $ENV_FILE"
  exit 1
fi

INVENTORY_DB_USER="$(node -e "const u = new URL(process.argv[1]); process.stdout.write(decodeURIComponent(u.username));" "$INVENTORY_DB_URL")"
INVENTORY_DB_PASSWORD="$(node -e "const u = new URL(process.argv[1]); process.stdout.write(decodeURIComponent(u.password));" "$INVENTORY_DB_URL")"
INVENTORY_DB_NAME="$(node -e "const u = new URL(process.argv[1]); process.stdout.write(decodeURIComponent(u.pathname.slice(1)));" "$INVENTORY_DB_URL")"

escape_identifier() {
  printf '%s' "$1" | sed 's/\"/\"\"/g'
}

escape_literal() {
  printf '%s' "$1" | sed "s/'/''/g"
}

ESCAPED_DB_USER="$(escape_identifier "$INVENTORY_DB_USER")"
ESCAPED_DB_PASSWORD="$(escape_literal "$INVENTORY_DB_PASSWORD")"
ESCAPED_DB_NAME="$(escape_identifier "$INVENTORY_DB_NAME")"
ESCAPED_DB_NAME_LITERAL="$(escape_literal "$INVENTORY_DB_NAME")"

echo "⏳ Waiting for local postgres admin connection..."
until psql "$ADMIN_DB_URL" -c '\q' >/dev/null 2>&1; do
  echo "   Waiting for postgres on ${ADMIN_DB_URL}..."
  sleep 2
done

ROLE_EXISTS="$(psql "$ADMIN_DB_URL" -tAc "SELECT 1 FROM pg_roles WHERE rolname = '${ESCAPED_DB_USER}'")"
if [ "$ROLE_EXISTS" != "1" ]; then
  echo "👤 Creating role ${INVENTORY_DB_USER}..."
  psql "$ADMIN_DB_URL" -v ON_ERROR_STOP=1 -c "CREATE ROLE \"${ESCAPED_DB_USER}\" LOGIN PASSWORD '${ESCAPED_DB_PASSWORD}';"
else
  echo "🔐 Syncing password for role ${INVENTORY_DB_USER}..."
  psql "$ADMIN_DB_URL" -v ON_ERROR_STOP=1 -c "ALTER ROLE \"${ESCAPED_DB_USER}\" WITH LOGIN PASSWORD '${ESCAPED_DB_PASSWORD}';"
fi

DATABASE_EXISTS="$(psql "$ADMIN_DB_URL" -tAc "SELECT 1 FROM pg_database WHERE datname = '${ESCAPED_DB_NAME_LITERAL}'")"
if [ "$DATABASE_EXISTS" != "1" ]; then
  echo "🧱 Creating database ${INVENTORY_DB_NAME}..."
  psql "$ADMIN_DB_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${ESCAPED_DB_NAME}\" OWNER \"${ESCAPED_DB_USER}\";"
else
  echo "ℹ️  Database ${INVENTORY_DB_NAME} already exists"
  psql "$ADMIN_DB_URL" -v ON_ERROR_STOP=1 -c "ALTER DATABASE \"${ESCAPED_DB_NAME}\" OWNER TO \"${ESCAPED_DB_USER}\";"
fi

echo "🔐 Verifying inventory role can connect..."
psql "$INVENTORY_DB_URL" -c 'select current_database(), current_user;' >/dev/null

echo "📋 Applying inventory migrations..."
npm run prisma:migrate:deploy

echo "🔧 Generating Prisma client..."
npm run prisma:generate

echo "✅ Inventory database setup complete"
