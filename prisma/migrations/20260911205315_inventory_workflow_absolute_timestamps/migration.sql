-- AlterTable
ALTER TABLE "inventory_command_recoveries" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "resolved_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "inventory_commands" ALTER COLUMN "received_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "completed_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "inventory_inbox_events" ALTER COLUMN "received_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "inventory_result_outbox" ALTER COLUMN "next_attempt_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "lease_expires_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "delivered_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "reservation_operations" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "stock_reservations" ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "scope_closed_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3);
