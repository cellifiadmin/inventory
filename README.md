# inventory

Inventory is the split vendor domain service for seller inventory, media, and stock lifecycle flows.

Current scope:
- local `serverless-offline` ports `3022` / `3032`
- shared offline authorizer proxy plus unauthenticated `GET /health`
- inventory items and item-resolution flows
- centralized media grants plus inventory-owned image read models under `/inventory/*`
- `POST /inventories` and create-via-write inventory flows now reject photo-less creates; a new item must arrive with at least one finalized photo payload so seller listings cannot be created without persistent media
- `PUT /inventory/items/{id}` materializes finalized centralized media assets into the inventory blob/attachment read model, keeps `mainImageId` in sync, and emits the offers `IMAGES_UPDATED` event from committed item state when `photos` or `mainPhotoHash` changes
- inventory item photo sync resolves persisted photos by owned `blobId` or seller-owned logical `assetRef`; new uploads without a centralized `assetRef` are rejected and checksum/key-only fallback matching is no longer supported
- explicit empty-photo writes normalize any stale `mainPhotoHash` to `null`, so clearing all listing photos does not fail with `Photo invalid`
- offer-facing inventory media snapshots now include a permanent `cdnUrl` on `mainPhoto`/`photos` and do not generate `previewUrl`; image sync to `offers` emits that `cdnUrl` directly so downstream publication does not rebuild media URLs from storage keys
- blob-to-CDN URL helpers must remain import-safe; missing `CLOUDFRONT_DOMAIN` or `OBJECT_STORAGE_PUBLIC_BASE_URL` may fail the specific URL-generation call, but must not crash unrelated inventory handlers during module initialization
- `POST /inventory/item-resolutions` must stay decoupled from seller listing read-model modules; IMEI-conflict link lookups should use narrow `offers` reads instead of importing the broader inventory listing browse service
- seller-facing attachment CDN endpoints (`GET /inventory/items/{id}/attachments/cdn` and `GET /inventory/items/attachments/cdn`) publish stable object URLs, but the attachment membership itself is mutable, so both responses must stay `Cache-Control: no-store`
- seller inventory account addresses under `/inventory/account-addresses/*`
- stock movement and sold-state flows
- approved business-upgrade address sync through the internal Lambda
  `inventory-<stage>-sync-approved-addresses`
- seller `WAREHOUSE`/`PICKUP` account-address coordinate ownership and geocoding

Extracted HTTP surface:
- `/inventory/media-grants`
- `/inventory/items/*`
- `/inventory/account-addresses/*`
- `/inventory/item-resolutions`
- `/inventories`
- `/inventories/{id}/mark-as-sold`

Listing photo normalization contract:
- Active MP seller listing-photo uploads now use the centralized flow:
  - `POST /inventory/media-grants`
  - `POST /media/upload-sessions`
  - browser `PUT` to the returned media upload URL
  - `POST /media/assets`
  - `POST /inventories` or `PUT /inventory/items/{id}` carrying finalized photo metadata (`assetRef`, serving `key`, checksum, mimeType, size, name)
- inventory blob rows are keyed logically by seller-owned `assetRef`; the same normalized physical serving `key` may appear across multiple blob rows when different logical listing-photo slots reuse identical media content
- inventory media grants now issue a seller-owned logical `assetKey` per photo (`ph_<random>`) and active item-owned refs use:
  - `inventory/items/{sellerIdentifier}/listing-photo/{photoKey}`
- In that active flow, `inventory` no longer exposes or tolerates legacy direct blob/attachment mutation routes for seller listing photos. `media` owns upload sessions, checksum dedupe, physical object keys, and normalized listing-photo renditions, while `inventory` only materializes the finalized asset into its seller-owned blob/attachment read model during inventory writes.
- The normalized listing-photo rendition is owned by `media`; inventory persists the resulting serving key and public CDN URL into its read model and downstream offers sync payloads.

Stock ownership contract:
- inventory movement aggregation is the sole source of truth for remaining stock
- `POST /inventories/{id}/mark-as-sold` may omit quantity; the service computes the live remaining balance and writes one `OUT` movement that zeroes the ledger
- offers sync is emitted only when a newly created `OUT` movement transitions `availableUnits` from `> 0` to `0`
- the zero-stock sync payload is keyed by `sellerIdentifier + itemCode + direction`; it does not include `inventoryItemId`, `remainingQuantity`, or `totalStock`

Seller account-address coordinate contract:
- `inventory` is the only service that derives missing latitude/longitude for seller `WAREHOUSE` and `PICKUP` account addresses
- direct `/inventory/account-addresses/*` writes and approved-address provisioning both geocode missing coordinates before persistence
- provided coordinates are preserved as-is; downstream services should only reuse them
- if a new address is missing coordinates and does not contain a complete geocodable address (`line1`, `city`, `stateCode`, `postalCode`, `countryCode`), the write is rejected instead of saving null coordinates
- no legacy backfill is performed in this service for previously persisted null-coordinate records
- runtime geocoding requires `GOOGLE_MAPS_API_KEY` in both local env and cloud runtime-sensitive secret bundles

Current local verification:
- Prisma generate and validate pass against `prisma/schema.prisma`
- config and inventory-focused unit tests pass
- `npm run package:local` passes and prepares the linux `sharp` binary needed for Lambda packaging
- local published image `cdnUrl` values should come from `OBJECT_STORAGE_PUBLIC_BASE_URL` (for example `http://cdn.localhost.localstack.cloud:4566/cellifi-local`) while raw object reads/writes still use `S3_ENDPOINT=http://localhost:4566`

Env files contract:
- tracked stage files are `.env.local`, `.env.test`, `.env.development`, and `.env.production`
- `.env.local` / `.env.test` keep direct inventory-local values, including inventory-owned queue wiring and local object-storage settings
- `.env.development` / `.env.production` keep deterministic direct SSM and Secrets Manager references under the inventory runtime namespace
- inventory env files must stay inventory-scoped and may carry only inventory-owned runtime variables and inventory-owned integration values such as the offers stock-sync queue settings
- no committed shared `inventory/.env` should be used as the source of truth

Local/test database contract:
- `inventory` uses native Postgres on `localhost:5432`
- local DB: `inventory_local` with role `inventory_user`
- test DB: `inventory_test` with role `inventory_test`
- run `npm run local:db:setup` and `npm run test:db:setup` once to provision and migrate each environment

Cloud deploy contract:
- Lambda artifacts must include `node_modules/.prisma/inventoryClient/libquery_engine-rhel-openssl-3.0.x.so.node` and `node_modules/.prisma/inventoryClient/schema.prisma`
- after provisioning a new cloud `inventory` database, run `npm run prisma:migrate:deploy` before expecting `/inventory/items`, `/inventory/media-grants`, seller address, or movement routes to work
- `inventory` currently has no standalone cloud seed; an empty database is valid after migration and will return empty collections until sellers create records

Known follow-up:
- offers publication side effects are still mirrored locally through the replicated offer read model until the standalone `offers` service is extracted and wired end to end
