ALTER TABLE "blobs"
ADD COLUMN "asset_ref" VARCHAR(512);

CREATE UNIQUE INDEX "blobs_asset_ref_key" ON "blobs"("asset_ref");
