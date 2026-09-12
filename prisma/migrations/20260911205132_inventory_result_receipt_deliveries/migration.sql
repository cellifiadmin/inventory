/*
  Warnings:

  - A unique constraint covering the columns `[receipt_id]` on the table `inventory_result_outbox` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `receipt_id` to the `inventory_result_outbox` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "inventory_result_outbox_event_id_key";

-- DropIndex
DROP INDEX "inventory_result_outbox_operation_id_key";

-- AlterTable
ALTER TABLE "inventory_result_outbox" ADD COLUMN     "receipt_id" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "inventory_result_outbox_receipt_id_key" ON "inventory_result_outbox"("receipt_id");

-- CreateIndex
CREATE INDEX "inventory_result_outbox_operation_id_idx" ON "inventory_result_outbox"("operation_id");

-- CreateIndex
CREATE INDEX "inventory_result_outbox_event_id_idx" ON "inventory_result_outbox"("event_id");

-- AddForeignKey
ALTER TABLE "inventory_result_outbox" ADD CONSTRAINT "inventory_result_outbox_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "inventory_inbox_events"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
