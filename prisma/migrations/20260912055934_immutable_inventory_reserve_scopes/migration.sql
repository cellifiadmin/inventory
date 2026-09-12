/*
  Warnings:

  - A unique constraint covering the columns `[scope_line_id]` on the table `stock_reservations` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[scope_line_id,checkout_id,checkout_version,line_id]` on the table `stock_reservations` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `scope_line_id` to the `stock_reservations` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "InventoryReserveScopeState" AS ENUM ('CLAIMED', 'RESERVED', 'CLOSED_NO_EFFECT');

-- CreateEnum
CREATE TYPE "InventoryReserveClosureReason" AS ENUM ('RESERVE_REJECTED', 'RESERVE_DEADLINE_EXPIRED', 'RESERVE_EXPIRED', 'CANCELLED');

-- AlterTable
ALTER TABLE "stock_reservations" ADD COLUMN     "scope_line_id" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "inventory_reserve_scopes" (
    "id" TEXT NOT NULL,
    "checkout_id" TEXT NOT NULL,
    "checkout_version" INTEGER NOT NULL,
    "reserve_operation_id" TEXT NOT NULL,
    "reserve_operation_input_hash" TEXT NOT NULL,
    "reserve_input_hash" TEXT NOT NULL,
    "original_descriptor_hash" TEXT NOT NULL,
    "original_descriptor" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "state" "InventoryReserveScopeState" NOT NULL DEFAULT 'CLAIMED',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "protected_revision" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_reserve_scopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_reserve_scope_lines" (
    "id" TEXT NOT NULL,
    "scope_id" TEXT NOT NULL,
    "checkout_id" TEXT NOT NULL,
    "checkout_version" INTEGER NOT NULL,
    "line_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "source_inv_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "inventory_reserve_scope_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_reserve_no_effect_closures" (
    "id" TEXT NOT NULL,
    "scope_id" TEXT NOT NULL,
    "authorizing_operation_id" TEXT NOT NULL,
    "reason" "InventoryReserveClosureReason" NOT NULL,
    "closed_at" TIMESTAMPTZ(3) NOT NULL,
    "evidence_hash" TEXT NOT NULL,

    CONSTRAINT "inventory_reserve_no_effect_closures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inventory_reserve_scopes_reserve_operation_id_key" ON "inventory_reserve_scopes"("reserve_operation_id");

-- CreateIndex
CREATE INDEX "inventory_reserve_scopes_state_created_at_idx" ON "inventory_reserve_scopes"("state", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_reserve_scopes_checkout_id_checkout_version_key" ON "inventory_reserve_scopes"("checkout_id", "checkout_version");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_reserve_scopes_id_checkout_id_checkout_version_key" ON "inventory_reserve_scopes"("id", "checkout_id", "checkout_version");

-- CreateIndex
CREATE INDEX "inventory_reserve_scope_lines_checkout_id_checkout_version_idx" ON "inventory_reserve_scope_lines"("checkout_id", "checkout_version");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_reserve_scope_lines_scope_id_line_id_key" ON "inventory_reserve_scope_lines"("scope_id", "line_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_reserve_scope_lines_id_checkout_id_checkout_versi_key" ON "inventory_reserve_scope_lines"("id", "checkout_id", "checkout_version", "line_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_reserve_no_effect_closures_scope_id_key" ON "inventory_reserve_no_effect_closures"("scope_id");

-- CreateIndex
CREATE INDEX "inventory_reserve_no_effect_closures_authorizing_operation__idx" ON "inventory_reserve_no_effect_closures"("authorizing_operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_reservations_scope_line_id_key" ON "stock_reservations"("scope_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_reservations_scope_line_id_checkout_id_checkout_versi_key" ON "stock_reservations"("scope_line_id", "checkout_id", "checkout_version", "line_id");

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_scope_line_id_checkout_id_checkout_vers_fkey" FOREIGN KEY ("scope_line_id", "checkout_id", "checkout_version", "line_id") REFERENCES "inventory_reserve_scope_lines"("id", "checkout_id", "checkout_version", "line_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_reserve_scope_lines" ADD CONSTRAINT "inventory_reserve_scope_lines_scope_id_checkout_id_checkou_fkey" FOREIGN KEY ("scope_id", "checkout_id", "checkout_version") REFERENCES "inventory_reserve_scopes"("id", "checkout_id", "checkout_version") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_reserve_no_effect_closures" ADD CONSTRAINT "inventory_reserve_no_effect_closures_scope_id_fkey" FOREIGN KEY ("scope_id") REFERENCES "inventory_reserve_scopes"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_reserve_no_effect_closures" ADD CONSTRAINT "inventory_reserve_no_effect_closures_authorizing_operation_fkey" FOREIGN KEY ("authorizing_operation_id") REFERENCES "inventory_commands"("operation_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
