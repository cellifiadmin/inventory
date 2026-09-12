-- CreateEnum
CREATE TYPE "InventoryCommandProducer" AS ENUM ('commerce', 'fulfillment');

-- CreateEnum
CREATE TYPE "InventoryCommandState" AS ENUM ('RECEIVED', 'SUCCEEDED', 'FAILED', 'RECONCILING');

-- CreateEnum
CREATE TYPE "InventoryResultDeliveryState" AS ENUM ('PENDING', 'SENDING', 'DELIVERED', 'EXHAUSTED');

-- CreateTable
CREATE TABLE "inventory_commands" (
    "operation_id" TEXT NOT NULL,
    "producer" "InventoryCommandProducer" NOT NULL,
    "command" TEXT NOT NULL,
    "execution_id" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "resource_version" INTEGER NOT NULL,
    "operation_input_hash" TEXT NOT NULL,
    "envelope_hash" TEXT NOT NULL,
    "immutable_envelope" JSONB NOT NULL,
    "state" "InventoryCommandState" NOT NULL DEFAULT 'RECEIVED',
    "result" JSONB,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "inventory_commands_pkey" PRIMARY KEY ("operation_id")
);

-- CreateTable
CREATE TABLE "inventory_inbox_events" (
    "id" TEXT NOT NULL,
    "producer" "InventoryCommandProducer" NOT NULL,
    "event_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_inbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_result_outbox" (
    "id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "destination" "InventoryCommandProducer" NOT NULL,
    "payload" JSONB NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "state" "InventoryResultDeliveryState" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "fencing_token" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),

    CONSTRAINT "inventory_result_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_command_recoveries" (
    "id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "inventory_command_recoveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_commands_resource_type_resource_id_resource_versi_idx" ON "inventory_commands"("resource_type", "resource_id", "resource_version");

-- CreateIndex
CREATE INDEX "inventory_commands_state_received_at_idx" ON "inventory_commands"("state", "received_at");

-- CreateIndex
CREATE INDEX "inventory_inbox_events_operation_id_idx" ON "inventory_inbox_events"("operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_inbox_events_producer_event_id_key" ON "inventory_inbox_events"("producer", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_result_outbox_operation_id_key" ON "inventory_result_outbox"("operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_result_outbox_event_id_key" ON "inventory_result_outbox"("event_id");

-- CreateIndex
CREATE INDEX "inventory_result_outbox_state_next_attempt_at_id_idx" ON "inventory_result_outbox"("state", "next_attempt_at", "id");

-- CreateIndex
CREATE INDEX "inventory_result_outbox_state_lease_expires_at_id_idx" ON "inventory_result_outbox"("state", "lease_expires_at", "id");

-- CreateIndex
CREATE INDEX "inventory_command_recoveries_resolved_at_created_at_idx" ON "inventory_command_recoveries"("resolved_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_command_recoveries_operation_id_reason_key" ON "inventory_command_recoveries"("operation_id", "reason");

-- AddForeignKey
ALTER TABLE "inventory_inbox_events" ADD CONSTRAINT "inventory_inbox_events_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "inventory_commands"("operation_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_result_outbox" ADD CONSTRAINT "inventory_result_outbox_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "inventory_commands"("operation_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_command_recoveries" ADD CONSTRAINT "inventory_command_recoveries_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "inventory_commands"("operation_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
