/*
  Warnings:

  - A unique constraint covering the columns `[id,item_id]` on the table `movements` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[held_movement_id,item_id]` on the table `stock_reservations` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[released_movement_id,item_id]` on the table `stock_reservations` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[sold_movement_id,item_id]` on the table `stock_reservations` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "movements_id_item_id_key" ON "movements"("id", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_reservations_held_movement_id_item_id_key" ON "stock_reservations"("held_movement_id", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_reservations_released_movement_id_item_id_key" ON "stock_reservations"("released_movement_id", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_reservations_sold_movement_id_item_id_key" ON "stock_reservations"("sold_movement_id", "item_id");

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_attachable_id_fkey" FOREIGN KEY ("attachable_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_blob_id_fkey" FOREIGN KEY ("blob_id") REFERENCES "blobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_main_image_id_fkey" FOREIGN KEY ("main_image_id") REFERENCES "attachments"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "components" ADD CONSTRAINT "components_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "components" ADD CONSTRAINT "components_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "instances"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "components" ADD CONSTRAINT "components_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "bundles"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "movements" ADD CONSTRAINT "movements_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_current_price_id_fkey" FOREIGN KEY ("current_price_id") REFERENCES "prices"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_latest_publication_id_fkey" FOREIGN KEY ("latest_publication_id") REFERENCES "offer_publications"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "offer_publications" ADD CONSTRAINT "offer_publications_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visits" ADD CONSTRAINT "visits_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prices" ADD CONSTRAINT "prices_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_held_movement_id_item_id_fkey" FOREIGN KEY ("held_movement_id", "item_id") REFERENCES "movements"("id", "item_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_released_movement_id_item_id_fkey" FOREIGN KEY ("released_movement_id", "item_id") REFERENCES "movements"("id", "item_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_sold_movement_id_item_id_fkey" FOREIGN KEY ("sold_movement_id", "item_id") REFERENCES "movements"("id", "item_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
