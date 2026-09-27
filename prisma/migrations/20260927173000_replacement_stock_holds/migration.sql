-- CreateEnum
CREATE TYPE "ReplacementStockHoldState" AS ENUM ('HELD', 'COMMITTED', 'RELEASED');

-- AlterEnum
ALTER TYPE "MovementReason" ADD VALUE 'REPLACEMENT';

-- CreateTable
CREATE TABLE "replacement_stock_holds" (
    "id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "entitlement_id" TEXT NOT NULL,
    "seller_order_id" TEXT NOT NULL,
    "seller_account_id" TEXT NOT NULL,
    "purchase_id" TEXT NOT NULL,
    "commerce_seller_order_id" TEXT NOT NULL,
    "commerce_purchase_line_id" TEXT NOT NULL,
    "item_id" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "input_hash" VARCHAR(64) NOT NULL,
    "state" "ReplacementStockHoldState" NOT NULL DEFAULT 'HELD',
    "sale_identity" JSONB NOT NULL,
    "held_movement_id" INTEGER NOT NULL,
    "released_movement_id" INTEGER,
    "sold_movement_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "replacement_stock_holds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "replacement_stock_holds_operation_id_key" ON "replacement_stock_holds"("operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "replacement_stock_holds_shipment_id_key" ON "replacement_stock_holds"("shipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "replacement_stock_holds_held_movement_id_key" ON "replacement_stock_holds"("held_movement_id");

-- CreateIndex
CREATE UNIQUE INDEX "replacement_stock_holds_released_movement_id_key" ON "replacement_stock_holds"("released_movement_id");

-- CreateIndex
CREATE UNIQUE INDEX "replacement_stock_holds_sold_movement_id_key" ON "replacement_stock_holds"("sold_movement_id");

-- CreateIndex
CREATE INDEX "replacement_stock_holds_seller_order_id_idx" ON "replacement_stock_holds"("seller_order_id");

-- CreateIndex
CREATE INDEX "replacement_stock_holds_item_id_state_idx" ON "replacement_stock_holds"("item_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "replacement_stock_holds_held_movement_id_item_id_key" ON "replacement_stock_holds"("held_movement_id", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "replacement_stock_holds_released_movement_id_item_id_key" ON "replacement_stock_holds"("released_movement_id", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "replacement_stock_holds_sold_movement_id_item_id_key" ON "replacement_stock_holds"("sold_movement_id", "item_id");

-- AddForeignKey
ALTER TABLE "replacement_stock_holds" ADD CONSTRAINT "replacement_stock_holds_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "inventory_commands"("operation_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "replacement_stock_holds" ADD CONSTRAINT "replacement_stock_holds_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "replacement_stock_holds" ADD CONSTRAINT "replacement_stock_holds_held_movement_id_item_id_fkey" FOREIGN KEY ("held_movement_id", "item_id") REFERENCES "movements"("id", "item_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "replacement_stock_holds" ADD CONSTRAINT "replacement_stock_holds_released_movement_id_item_id_fkey" FOREIGN KEY ("released_movement_id", "item_id") REFERENCES "movements"("id", "item_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "replacement_stock_holds" ADD CONSTRAINT "replacement_stock_holds_sold_movement_id_item_id_fkey" FOREIGN KEY ("sold_movement_id", "item_id") REFERENCES "movements"("id", "item_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "replacement_stock_holds" ADD CONSTRAINT "replacement_stock_holds_quantity_positive_check"
CHECK ("quantity" > 0);

ALTER TABLE "replacement_stock_holds" ADD CONSTRAINT "replacement_stock_holds_state_movements_check"
CHECK (("state" = 'HELD' AND "released_movement_id" IS NULL AND "sold_movement_id" IS NULL)
    OR ("state" = 'RELEASED' AND "released_movement_id" IS NOT NULL AND "sold_movement_id" IS NULL)
    OR ("state" = 'COMMITTED' AND "released_movement_id" IS NOT NULL AND "sold_movement_id" IS NOT NULL));
