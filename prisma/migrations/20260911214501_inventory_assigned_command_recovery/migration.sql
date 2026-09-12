/*
  Warnings:

  - Added the required column `assigned_owner` to the `inventory_command_recoveries` table without a default value. This is not possible if the table is not empty.
  - Added the required column `due_at` to the `inventory_command_recoveries` table without a default value. This is not possible if the table is not empty.
  - Added the required column `next_action` to the `inventory_command_recoveries` table without a default value. This is not possible if the table is not empty.
  - Added the required column `severity` to the `inventory_command_recoveries` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "InventoryRecoverySeverity" AS ENUM ('HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "InventoryRecoveryAction" AS ENUM ('INSPECT_PAYMENT_AND_RESERVATION', 'REDELIVER_ORIGINAL_RESULT');

-- DropIndex
DROP INDEX "inventory_command_recoveries_resolved_at_created_at_idx";

-- AlterTable
ALTER TABLE "inventory_command_recoveries" ADD COLUMN     "assigned_owner" TEXT NOT NULL,
ADD COLUMN     "due_at" TIMESTAMPTZ(3) NOT NULL,
ADD COLUMN     "next_action" "InventoryRecoveryAction" NOT NULL,
ADD COLUMN     "severity" "InventoryRecoverySeverity" NOT NULL;

-- CreateIndex
CREATE INDEX "inventory_command_recoveries_resolved_at_due_at_idx" ON "inventory_command_recoveries"("resolved_at", "due_at");
