-- CreateEnum
CREATE TYPE "InventoryOwnerEventKind" AS ENUM ('INVENTORY_RESERVATION_EXPIRED');

-- AlterEnum
ALTER TYPE "InventoryRecoveryAction" ADD VALUE 'REDELIVER_OWNER_EVENT';

-- CreateTable
CREATE TABLE "inventory_owner_events" (
    "id" VARCHAR(191) NOT NULL,
    "scope_id" TEXT NOT NULL,
    "scope_revision" INTEGER NOT NULL,
    "checkout_id" TEXT NOT NULL,
    "checkout_version" INTEGER NOT NULL,
    "kind" "InventoryOwnerEventKind" NOT NULL,
    "observed_at" TIMESTAMPTZ(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "payload_hash" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_owner_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_owner_event_outbox" (
    "id" TEXT NOT NULL,
    "event_id" VARCHAR(191) NOT NULL,
    "state" "InventoryResultDeliveryState" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMPTZ(3),
    "fencing_token" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMPTZ(3),

    CONSTRAINT "inventory_owner_event_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_owner_event_recoveries" (
    "id" TEXT NOT NULL,
    "event_id" VARCHAR(191) NOT NULL,
    "reason" TEXT NOT NULL,
    "assigned_owner" TEXT NOT NULL,
    "severity" "InventoryRecoverySeverity" NOT NULL,
    "next_action" "InventoryRecoveryAction" NOT NULL,
    "due_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "inventory_owner_event_recoveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_owner_events_checkout_id_checkout_version_idx" ON "inventory_owner_events"("checkout_id", "checkout_version");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_owner_events_scope_id_scope_revision_key" ON "inventory_owner_events"("scope_id", "scope_revision");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_owner_event_outbox_event_id_key" ON "inventory_owner_event_outbox"("event_id");

-- CreateIndex
CREATE INDEX "inventory_owner_event_outbox_state_next_attempt_at_id_idx" ON "inventory_owner_event_outbox"("state", "next_attempt_at", "id");

-- CreateIndex
CREATE INDEX "inventory_owner_event_outbox_state_lease_expires_at_id_idx" ON "inventory_owner_event_outbox"("state", "lease_expires_at", "id");

-- CreateIndex
CREATE INDEX "inventory_owner_event_recoveries_resolved_at_due_at_idx" ON "inventory_owner_event_recoveries"("resolved_at", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_owner_event_recoveries_event_id_reason_key" ON "inventory_owner_event_recoveries"("event_id", "reason");

-- AddForeignKey
ALTER TABLE "inventory_owner_events" ADD CONSTRAINT "inventory_owner_events_scope_id_checkout_id_checkout_versi_fkey" FOREIGN KEY ("scope_id", "checkout_id", "checkout_version") REFERENCES "inventory_reserve_scopes"("id", "checkout_id", "checkout_version") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_owner_event_outbox" ADD CONSTRAINT "inventory_owner_event_outbox_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "inventory_owner_events"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_owner_event_recoveries" ADD CONSTRAINT "inventory_owner_event_recoveries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "inventory_owner_events"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
