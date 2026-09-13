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
- admin owner-side account-address reads and writes under
  `/inventory/admin/accounts/{accountIdentifier}/addresses`
- stock movement and sold-state flows
- typed stock reservations and payment protection through durable owner SQS commands, with scheduled result delivery and reservation expiry
- owner-first seller/admin account-address persistence reused before UM
  account-upgrade request creation and later read live by request pages
- seller `WAREHOUSE`/`PICKUP` account-address coordinate ownership and geocoding

Extracted HTTP surface:
- `/inventory/media-grants`
- `/inventory/items/*`
- `/inventory/account-addresses/*`
- `/inventory/admin/accounts/{accountIdentifier}/addresses`
- `/inventory/admin/accounts/{accountIdentifier}/addresses/{type}`
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

Stock ownership and workflow contract:
- Immutable movements remain the sole quantity truth. Typed `StockReservation` records hold checkout/version/line identity, expiry, revision, payment scope and fence, with database foreign keys to their held/released/sold movements; no movement metadata fallback is used.
- Each checkout version binds to one immutable reserve command and requested line set. Definitive zero-effect failures and explicit `INVENTORY_CLOSE_RESERVE` persist restrictive closure evidence that prevents delayed reserve messages from reopening the scope. Fresh `INVENTORY_OBSERVE` commands return current full reservation lineage or closure proof; absence remains UNKNOWN, while completed-command replay remains historical evidence.
- Reservation results carry the scope ID, original operation and input hashes, and scope revision. All-lines payment protection freezes the exact protected revision used by later seller commits, even after another seller subset has committed. Lifecycle locks consistently follow scope, command, then sorted stock items. Fresh close observations sample database time after persisting closure, so `observedAt` cannot precede `closedAt`.
- Prisma-generated migration `20260912055934_immutable_inventory_reserve_scopes` adds these relationships and requires empty legacy reservation tables at development cutover. It has been applied only to guarded `inventory_test`. Unit and actual PostgreSQL tests cover closure-before-delayed-reserve, atomic failure rollback, fresh observation versus historical replay, concurrent commands and delayed seller commits; advancing-clock regressions cover closure timestamps.
- Expiry, commit, and release atomically record a separate `WORKFLOW_OWNER_EVENT` for each changed reserve-scope revision. `INVENTORY_RESERVATION_EXPIRED`, `INVENTORY_RESERVATION_COMMITTED`, and `INVENTORY_RESERVATION_RELEASED` carry full current reservation lineage, the immutable original reserve scope and hashes, database observation time, and sorted exact changed reservation IDs. Commit events include the actual reservation operation, payment, purchase, commercial seller-order, payment scope and fence. Release events retain the actual operation, `payment_failed`/`cancelled` cause, and nullable closed-payment evidence. These owner facts do not fabricate command results or callback receipts.
- Commit/release lock every scope item in sorted order before changing a seller subset. An after-change hook verifies the persisted domain operation and its fresh full observation, then creates the immutable owner event and delivery row inside the same transaction as movements, reservation revisions and the domain operation. Event/outbox failure rolls back that transaction. Exact operation replay and no-op expiry emit no new fact. Stable `${scopeId}:revision:${revision}` identities and separate fenced delivery retries preserve immutable evidence through acknowledgment loss; delivery exhaustion creates assigned recovery.
- Prisma-generated migrations `20260912065024_inventory_reservation_expiry_owner_events` and `20260912074445_inventory_reservation_terminal_owner_events` were applied only to guarded `inventory_test`; the latter adds the two terminal event enum values. Unit and PostgreSQL tests cover terminal payload provenance, concurrent seller subsets, commit/release races, atomic event/outbox rollback, replay, and expiry no-ops. Commerce consumes terminal facts for admission accounting independently of business callbacks; purchase and payment truth must not be inferred from delivery acknowledgments.
- Commerce reserves the entire frozen checkout/version line set in one atomic `INVENTORY_RESERVE` command. Same-item lines are aggregated before availability checks. All quantity writers lock distinct item rows in sorted order.
- Every reserve command supplies its frozen `expiresAt` as canonical UTC milliseconds. Inventory preserves that deadline, checks it against the database clock after stock locks and before each line write, and rejects deadline changes for an existing checkout/version. An elapsed later line rolls back the entire reservation. There is no Inventory timeout default or environment setting; Commerce must derive the deadline from its approved admission policy. Completed operation replay returns historical evidence, not a renewed hold.
- `INVENTORY_PROTECT` moves ordinary holds to `PAYMENT_LOCKED` under a payment scope and fence. Protected stock never expires automatically. Fulfillment's trusted command queue can commit an exact seller subset using reservation IDs, current revisions, payment identity, purchase identity and commercial seller-order lineage.
- Commit writes `IN + RELEASED` and `OUT + SOLD` atomically. Release of protected stock requires explicit closed-payment evidence and a newer fence; unknown payment outcomes never release stock. Expiry scans only unprotected `HELD` rows and rechecks state under item locks using the database clock.
- The strict `WORKFLOW_COMMAND` envelope carries the originating audit actor and immutable owner operation/execution/resource scope. Producer authority comes from exact configured Standard SQS source ARNs; malformed, equal or FIFO queue configuration is rejected before any record effects. Canonical SHA256 matches the owner's workflow kind, resource, step, participant, input and deadline scope.
- Inbox receipt, domain operation, immutable result and delivery outbox persist in one database transaction. Exact replay has no duplicate stock effect; changed immutable input is rejected. A fresh reconciliation receipt creates a new delivery of the original result.
- `WORKFLOW_RESULT` preserves the remote scope and stable `${operationId}:result` event ID. Definitive rejection returns a safe error code; an unseen expired protect/commit/release returns `UNKNOWN` plus a durable recovery record assigned to `inventory-operations` with severity, a specific next action and a database-clock due date. Recovery uses a separate inspected operation, preserving the original result.
- The Standard SQS publisher sends outside the transaction and uses leased, fenced outbox claims, bounded retries and assigned recovery on exhaustion. A successful send requires a nonempty SQS `MessageId`; an unknown acknowledgement retries the original event. A send accepted before a lost database acknowledgement is delivered again with the same logical result identity.
- The former `/stock/reserve`, `/stock/commit` and `/stock/release` HTTP routes and their HMAC secret dependency are removed. There is no HTTP fallback for workflow commands.
- `POST /inventories/{id}/mark-as-sold` may omit quantity; it computes the live ledger balance under the same item lock and writes an `OUT` movement.
- Offers sync is emitted when a newly created `OUT` movement transitions `availableUnits` from `> 0` to `0`; its payload is `sellerIdentifier + itemCode + direction`.

Workflow runtime:
- Node.js 22 runs one reservation command consumer over the separate Commerce and Fulfillment Standard queues. Both mappings use `ReportBatchItemFailures`; runtime source ARN validation selects authority.
- `publishReservationResults`, `publishReservationOwnerEvents` and `expireStockReservations` run every minute in cloud. Result publication has a 25-second claim budget, 20-second send timeout and 60-second Lambda timeout.
- Infrastructure owns queue creation, redrive policy, DLQs and producer permissions. The canonical contract is `infrastructure/modules/marketplace_workflow_queues/queues.json`; Inventory receives twelve URL/ARN bindings, including its two command DLQs. Cloud bindings use `/cellifi/<dev|test|prod>/inventory/runtime/<lowercase-env-name-with-hyphens>`.
- Docker's infrastructure bootstrap provisions local queues. For an explicit local refresh, run `CELLIFI_INFRASTRUCTURE_ROOT=/path/to/infrastructure npm run local:queue:ensure` (`CELLIFI_LOCAL_STAGE=test` selects isolated test queues). The helper defaults to the sibling infrastructure checkout and never defines independent queue attributes.
- `npm run dev` uses `serverless offline start` so plugin lifecycle hooks run. The installed offline plugin also invokes these schedule handlers automatically every minute. `serverless-offline` starts HTTP before `serverless-offline-sqs`; the latter consumes already-provisioned queues with `autoCreate: false`. The SQS plugin uses the same explicit local endpoint as the SDK, so an isolated acceptance container can run on port 4567. Do not start a second command consumer against the same local queue.

Seller account-address coordinate contract:
- `inventory` is the only service that derives missing latitude/longitude for seller `WAREHOUSE` and `PICKUP` account addresses
- seller `/inventory/account-addresses/*` writes and admin `/inventory/admin/accounts/{accountIdentifier}/addresses/{type}` writes both geocode missing coordinates before persistence
- provided coordinates are preserved as-is; downstream services should only reuse them
- if a new address is missing coordinates and does not contain a complete geocodable address (`line1`, `city`, `stateCode`, `postalCode`, `countryCode`), the write is rejected instead of saving null coordinates
- no legacy backfill is performed in this service for previously persisted null-coordinate records
- runtime geocoding requires `GOOGLE_MAPS_API_KEY` in both local env and cloud runtime-sensitive secret bundles
- admin owner-side reads reuse the same current account-address record shape as
  seller `GET /inventory/account-addresses`, but target the path
  `accountIdentifier`
- admin owner-side writes reuse the same normalization, validation, and
  coordinate-derivation behavior as seller `PUT /inventory/account-addresses/{type}`,
  but upsert against the path-owned `accountIdentifier` via
  `PUT /inventory/admin/accounts/{accountIdentifier}/addresses/{type}`
- upgrade-request pages in `mp` read current `WAREHOUSE`/`PICKUP` state live from
  these owner-side records rather than from UM request snapshots
- admin access for `/inventory/admin/*` is token-authoritative: only
  `authUser.isAdmin === true` grants access, and UM-enriched `userRoles` must
  not elevate permissions

Current local verification:
- Prisma generate and validate pass against `prisma/schema.prisma`
- config and inventory-focused unit tests pass
- `npm run package:local` passes and prepares the linux `sharp` binary needed for Lambda packaging
- local published image `cdnUrl` values should come from `OBJECT_STORAGE_PUBLIC_BASE_URL` (for example `http://cdn.localhost.localstack.cloud:4566/cellifi-local`) while raw object reads/writes still use `S3_ENDPOINT=http://localhost:4566`

Env files contract:
- tracked stage files are `.env.local`, `.env.test`, `.env.development`, and `.env.production`
- `.env.local` / `.env.test` keep direct inventory-local values, including inventory-owned queue wiring and local object-storage settings
- `.env.development` / `.env.production` keep deterministic direct SSM and Secrets Manager references under the inventory runtime namespace, including owner command/result queue bindings
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

Purchase workflow implementation verification:

- `npm run test:purchase:unit` runs scoped unit tests; `npm run test:purchase:coverage` enforces 100% statements, branches, functions and lines per executable module, including unloaded files and owned dependencies. Current coverage is below this release gate.
- `npm run test:purchase:integration` uses only the isolated local inventory_test database and matching role, with fixture-owned cleanup. Direct invocation of the integration files applies the same target guard.
- `npm run test:purchase:providers` is reserved for real provider acceptance; absence of tests is a failed gate, not evidence of successful integration. Unit fault injection does not satisfy it.
- `npm run test:purchase:regression` isolates characterized runtime simulation failures. The implementation branch intentionally retains failing business regressions until their owning changes land.
- Reports are separate under `coverage/purchase-*`; module selection is recorded in `test/purchase-coverage-manifest.json`. `npm run test:config` also verifies unloaded-module coverage and suite separation.

Reservation and workflow verification:

- Unit tests cover strict canonical envelopes, whole-checkout atomic reservation, sorted stock locks, payment protection and terminal transitions, safe error results, trusted queue ingress, fenced delivery retries, and accepted-send acknowledgement loss.
- PostgreSQL tests cover concurrent replay and commit/release races, actual foreign key lineage rejection, enclosing transaction rollback, durable unknown outcomes, reconciliation redelivery, exact seller subsets and UTC/Europe-Berlin deadline behavior. Every new lifecycle/workflow timestamp is `TIMESTAMPTZ(3)`.
- `test/integration/inventoryClosureRaces.test.ts` adds six deterministic PostgreSQL checks using real transaction connections and `pg_blocking_pids` barriers without sleeps: CLOSE observing HELD before delayed protection, both protection/release lock orders, atomic stale-subset rejection followed by fresh repartition, and both disjoint release/commit orders. CLOSE of materialized stock is an observation, not a payment fence; release fences apply only to released lines. Full-scope owner events identify only the actual changed subset. The synthetic financial assertion in these tests does not establish provider cancellation or authorize Commerce to release stock funded by captured money. This slice changes tests only; verification passed 387 unit tests, 71 PostgreSQL tests, 31 config tests, and strict TypeScript checking.
- Use Node.js 22 (`nvm use`). `npx tsc --noEmit` checks source and tests strictly; database/service mocks declare their asynchronous result signatures.
- The changed lifecycle and workflow modules have 100% statements, branches, functions and lines in focused verification. The wider transitive purchase coverage release gate remains below its threshold, and provider acceptance is still a separate required gate.
- Download and preview URLs pass their five-minute expiry to AWS SDK v3 presigner options; URL tests verify `X-Amz-Expires=300`.


Local workflow startup:

Run workspace Docker and wait until its ready hooks have created the queues,
published coordinators and `.local/workflows/local.json`. Then, from this service,
run `npm run dev` or `npm run local` (default stage `local`). Both commands use
`scripts/run-local-workflow.sh`, which invokes the infrastructure runtime validator
before the service-local Serverless executable. Queue provisioning remains owned
by Docker/infrastructure; the launcher only reads verified resource references.

The wrapper defaults to the sibling `../infrastructure` checkout and workspace
`../.local/workflows/<stage>.json`, resolving paths from this repository.
`CELLIFI_LOCAL_STAGE=local|test` selects the local resource namespace and matching
runtime artifact. Serverless always uses `--stage local` to resolve the direct
local runtime map. Its cloud `test` stage resolves SSM and is not the local test
queue namespace. For a separate worktree and isolated test runtime, set all three:

```sh
CELLIFI_LOCAL_STAGE=test \
CELLIFI_INFRASTRUCTURE_ROOT=/path/to/infrastructure-worktree \
CELLIFI_LOCAL_WORKFLOW_RUNTIME_FILE=/path/to/workspace/.local/workflows/test.json \
npm run dev
```

Optional Serverless flags retain their argument boundaries, for example
`npm run dev -- --httpPort 9999`. Forwarded `--stage`, `--stage=...`, `-s` and
`-s...` options are rejected; use `CELLIFI_LOCAL_STAGE` instead. The artifact must
describe that selected resource namespace. Selecting test resources does not select
a test database: the acceptance helper must inject guarded test database and
service secret configuration before calling the wrapper. The infrastructure
launcher preserves database and provider
configuration, forces local AWS test credentials and injects only this owner's
canonical queue/workflow references. Missing files or inconsistent values never
fall back to manually copied ARN environment variables. `npm run test:config`
checks the wrapper defaults, worktree overrides and exact forwarded arguments.
