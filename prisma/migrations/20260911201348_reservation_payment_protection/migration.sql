-- CreateEnum
CREATE TYPE "ReservationState" AS ENUM ('HELD', 'PAYMENT_LOCKED', 'COMMITTED', 'RELEASED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ReservationOperationKind" AS ENUM ('RESERVE', 'PROTECT', 'COMMIT', 'RELEASE', 'EXPIRE');

-- CreateTable
CREATE TABLE "stock_reservations" (
    "id" TEXT NOT NULL,
    "checkout_id" TEXT NOT NULL,
    "checkout_version" INTEGER NOT NULL,
    "line_id" TEXT NOT NULL,
    "item_id" INTEGER NOT NULL,
    "state" "ReservationState" NOT NULL DEFAULT 'HELD',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "payment_scope_id" TEXT,
    "fence" INTEGER NOT NULL DEFAULT 0,
    "payment_id" TEXT,
    "purchase_id" TEXT,
    "commerce_seller_order_id" TEXT,
    "resolution_id" TEXT,
    "scope_closed_at" TIMESTAMP(3),
    "release_cause" TEXT,
    "held_movement_id" INTEGER NOT NULL,
    "released_movement_id" INTEGER,
    "sold_movement_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_operations" (
    "id" TEXT NOT NULL,
    "kind" "ReservationOperationKind" NOT NULL,
    "checkout_id" TEXT NOT NULL,
    "checkout_version" INTEGER NOT NULL,
    "input_fingerprint" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_reservations_held_movement_id_key" ON "stock_reservations"("held_movement_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_reservations_released_movement_id_key" ON "stock_reservations"("released_movement_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_reservations_sold_movement_id_key" ON "stock_reservations"("sold_movement_id");

-- CreateIndex
CREATE INDEX "stock_reservations_item_id_idx" ON "stock_reservations"("item_id");

-- CreateIndex
CREATE INDEX "stock_reservations_state_expires_at_id_idx" ON "stock_reservations"("state", "expires_at", "id");

-- CreateIndex
CREATE INDEX "stock_reservations_payment_scope_id_state_idx" ON "stock_reservations"("payment_scope_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "stock_reservations_checkout_id_checkout_version_line_id_key" ON "stock_reservations"("checkout_id", "checkout_version", "line_id");

-- CreateIndex
CREATE INDEX "reservation_operations_checkout_id_checkout_version_idx" ON "reservation_operations"("checkout_id", "checkout_version");

