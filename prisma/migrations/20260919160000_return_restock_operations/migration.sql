-- AlterEnum
ALTER TYPE "MovementReason" ADD VALUE 'RETURNED';

-- CreateTable
CREATE TABLE "return_restock_operations" (
    "operation_id" VARCHAR(160) NOT NULL,
    "return_id" VARCHAR(191) NOT NULL,
    "seller_order_id" VARCHAR(191) NOT NULL,
    "seller_account_id" VARCHAR(191) NOT NULL,
    "evidence_hash" VARCHAR(64) NOT NULL,
    "input_hash" VARCHAR(64) NOT NULL,
    "input" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "return_restock_operations_pkey" PRIMARY KEY ("operation_id")
);

-- CreateTable
CREATE TABLE "return_restock_lines" (
    "id" TEXT NOT NULL,
    "operation_id" VARCHAR(160) NOT NULL,
    "item_id" INTEGER NOT NULL,
    "movement_id" INTEGER NOT NULL,
    "commerce_purchase_line_id" VARCHAR(191) NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "return_restock_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "return_restock_operations_return_id_key" ON "return_restock_operations"("return_id");

-- CreateIndex
CREATE INDEX "return_restock_operations_seller_order_id_idx" ON "return_restock_operations"("seller_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "return_restock_lines_movement_id_key" ON "return_restock_lines"("movement_id");

-- CreateIndex
CREATE INDEX "return_restock_lines_item_id_idx" ON "return_restock_lines"("item_id");

-- CreateIndex
CREATE UNIQUE INDEX "return_restock_lines_operation_id_commerce_purchase_line_id_key" ON "return_restock_lines"("operation_id", "commerce_purchase_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "return_restock_lines_movement_id_item_id_key" ON "return_restock_lines"("movement_id", "item_id");

-- AddForeignKey
ALTER TABLE "return_restock_lines" ADD CONSTRAINT "return_restock_lines_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "return_restock_operations"("operation_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "return_restock_lines" ADD CONSTRAINT "return_restock_lines_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "return_restock_lines" ADD CONSTRAINT "return_restock_lines_movement_id_item_id_fkey" FOREIGN KEY ("movement_id", "item_id") REFERENCES "movements"("id", "item_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "return_restock_operations"
  ADD CONSTRAINT "return_restock_operations_hash_check" CHECK (
    "evidence_hash" ~ '^[a-f0-9]{64}$' AND "input_hash" ~ '^[a-f0-9]{64}$'
  );
ALTER TABLE "return_restock_lines"
  ADD CONSTRAINT "return_restock_lines_quantity_check" CHECK ("quantity" > 0);
