-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ItemKind" AS ENUM ('STOCK', 'LISTING');

-- CreateEnum
CREATE TYPE "OfferPublicationAction" AS ENUM ('LIST', 'DELIST');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "ComponentChildType" AS ENUM ('INSTANCE', 'BUNDLE');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('PHONE', 'WATCH', 'TABLET', 'ACCESSORY');

-- CreateEnum
CREATE TYPE "MovementDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "MovementReason" AS ENUM ('STOCKED', 'SOLD', 'TRANSFERRED', 'DAMAGED', 'ADJUSTMENT', 'ADJUSTED', 'RESERVED');

-- CreateTable
CREATE TABLE "blobs" (
    "key" VARCHAR(255) NOT NULL,
    "checksum" TEXT NOT NULL,
    "url" TEXT,
    "size" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "extension" VARCHAR(10) NOT NULL,
    "file_type" TEXT NOT NULL,
    "id" SERIAL NOT NULL,

    CONSTRAINT "blobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "metadata" JSONB,
    "attachable_type" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,
    "id" SERIAL NOT NULL,
    "blob_id" INTEGER NOT NULL,
    "attachable_id" INTEGER NOT NULL,
    "attachment_type" TEXT NOT NULL,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "items" (
    "id" SERIAL NOT NULL,
    "kind" "ItemKind" NOT NULL,
    "item_code" VARCHAR(255) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "address_line1" VARCHAR(255),
    "address_line2" VARCHAR(255),
    "address_city" VARCHAR(100),
    "address_state_code" VARCHAR(32),
    "address_postal_code" VARCHAR(20),
    "address_country_code" VARCHAR(3),
    "address_latitude" DOUBLE PRECISION,
    "address_longitude" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "main_image_id" INTEGER,
    "seller_identifier" VARCHAR(50) NOT NULL DEFAULT 'seller',

    CONSTRAINT "items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_addresses" (
    "id" SERIAL NOT NULL,
    "account_identifier" VARCHAR(50) NOT NULL,
    "type" VARCHAR(32) NOT NULL,
    "line1" VARCHAR(255),
    "line2" VARCHAR(255),
    "city" VARCHAR(100),
    "state_code" VARCHAR(32),
    "postal_code" VARCHAR(20),
    "country_code" VARCHAR(3) NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "label" VARCHAR(50),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "account_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "components" (
    "id" SERIAL NOT NULL,
    "item_id" INTEGER NOT NULL,
    "child_type" "ComponentChildType" NOT NULL,
    "instance_id" INTEGER,
    "bundle_id" INTEGER,
    "component_snapshot" JSONB,
    "position" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instances" (
    "id" SERIAL NOT NULL,
    "identifier" VARCHAR(255) NOT NULL,
    "sku" VARCHAR(50) NOT NULL,
    "product_type" "ProductType" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bundles" (
    "id" SERIAL NOT NULL,
    "sku" VARCHAR(50) NOT NULL,
    "product_type" "ProductType" NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bundles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "movements" (
    "id" SERIAL NOT NULL,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "item_id" INTEGER NOT NULL,
    "direction" "MovementDirection" NOT NULL,
    "reason" "MovementReason" NOT NULL,
    "metadata" JSONB,
    "created_by" INTEGER,

    CONSTRAINT "movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offers" (
    "id" SERIAL NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "valid_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_to" TIMESTAMP(3),
    "local" BOOLEAN DEFAULT true,
    "online" BOOLEAN DEFAULT false,
    "slug" VARCHAR(255),
    "deleted_at" TIMESTAMP(3),
    "current_price_id" INTEGER,
    "seller_identifier" VARCHAR(50),
    "item_code" VARCHAR(255),
    "min_order_units" INTEGER NOT NULL DEFAULT 1,
    "status" "OfferStatus" NOT NULL DEFAULT 'INACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "expired_at" TIMESTAMP(3),
    "latest_publication_id" INTEGER,
    "address_state" VARCHAR(10),
    "address_country" VARCHAR(3),
    "currency_code" VARCHAR(3),
    "currency_symbol" VARCHAR(10),

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer_publications" (
    "id" SERIAL NOT NULL,
    "offer_id" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "action" "OfferPublicationAction" NOT NULL,
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_publications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visits" (
    "id" SERIAL NOT NULL,
    "offer_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prices" (
    "id" SERIAL NOT NULL,
    "offer_id" INTEGER NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "blobs_key_key" ON "blobs"("key");

-- CreateIndex
CREATE INDEX "blobs_key_idx" ON "blobs"("key");

-- CreateIndex
CREATE INDEX "attachments_blob_id_attachable_id_attachable_type_attachmen_idx" ON "attachments"("blob_id", "attachable_id", "attachable_type", "attachment_type");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_blob_id_attachable_id_attachable_type_attachmen_key" ON "attachments"("blob_id", "attachable_id", "attachable_type", "attachment_type");

-- CreateIndex
CREATE INDEX "items_seller_identifier_idx" ON "items"("seller_identifier");

-- CreateIndex
CREATE INDEX "items_kind_idx" ON "items"("kind");

-- CreateIndex
CREATE INDEX "items_seller_identifier_kind_idx" ON "items"("seller_identifier", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "items_seller_identifier_item_code_key" ON "items"("seller_identifier", "item_code");

-- CreateIndex
CREATE INDEX "account_addresses_account_identifier_idx" ON "account_addresses"("account_identifier");

-- CreateIndex
CREATE UNIQUE INDEX "account_addresses_account_identifier_type_key" ON "account_addresses"("account_identifier", "type");

-- CreateIndex
CREATE UNIQUE INDEX "components_instance_id_key" ON "components"("instance_id");

-- CreateIndex
CREATE INDEX "components_item_id_idx" ON "components"("item_id");

-- CreateIndex
CREATE INDEX "components_bundle_id_idx" ON "components"("bundle_id");

-- CreateIndex
CREATE UNIQUE INDEX "components_item_id_bundle_id_key" ON "components"("item_id", "bundle_id");

-- CreateIndex
CREATE INDEX "instances_sku_idx" ON "instances"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "instances_identifier_sku_product_type_key" ON "instances"("identifier", "sku", "product_type");

-- CreateIndex
CREATE INDEX "bundles_sku_idx" ON "bundles"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "bundles_sku_product_type_count_key" ON "bundles"("sku", "product_type", "count");

-- CreateIndex
CREATE INDEX "movements_item_id_direction_idx" ON "movements"("item_id", "direction");

-- CreateIndex
CREATE UNIQUE INDEX "offers_slug_key" ON "offers"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "offers_current_price_id_key" ON "offers"("current_price_id");

-- CreateIndex
CREATE UNIQUE INDEX "offers_latest_publication_id_key" ON "offers"("latest_publication_id");

-- CreateIndex
CREATE INDEX "offers_seller_identifier_item_code_deleted_at_idx" ON "offers"("seller_identifier", "item_code", "deleted_at");

-- CreateIndex
CREATE INDEX "offers_seller_identifier_item_code_address_country_address__idx" ON "offers"("seller_identifier", "item_code", "address_country", "address_state", "min_order_units");

-- CreateIndex
CREATE INDEX "offer_publications_offer_id_published_at_idx" ON "offer_publications"("offer_id", "published_at");

-- CreateIndex
CREATE INDEX "offer_publications_offer_id_version_idx" ON "offer_publications"("offer_id", "version");

-- CreateIndex
CREATE INDEX "visits_offer_id_created_at_idx" ON "visits"("offer_id", "created_at");

-- CreateIndex
CREATE INDEX "prices_offer_id_idx" ON "prices"("offer_id");

