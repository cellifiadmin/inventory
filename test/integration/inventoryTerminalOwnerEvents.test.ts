require('../helpers/purchaseTestEnvironment.cjs');
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, afterAll, expect, it } from '@jest/globals';
import prisma from '@/lib/prismaInventory';
import { reserveStock, cleanupReservationScopeFixture } from '../helpers/reserveThroughOwner';
import { protectReservations } from '@/inventory/services/reservationProtectionService';
import { commitStock } from '@/inventory/services/stockCommitService';
import { releaseStock } from '@/inventory/services/stockReleaseService';
import { expireStockReservations } from '@/inventory/services/stockReservationExpiryService';
import { databaseNow } from '@/inventory/services/stockReservationShared';
import { inventoryOwnerEventSchema } from '@/inventory/types/inventoryOwnerEvent';
import type { ReservationResult } from '@/inventory/types/stockReservationCommands';
import { workflowInputHash } from '@/inventory/services/workflows/workflowIdentity';
let checkoutId: string, itemIds: number[], held: ReservationResult;
beforeEach(async () => {
  checkoutId = `terminal-owner-${randomUUID()}`;
  itemIds = [];
  const lines = [];
  for (let index = 0; index < 2; index++) {
    const accountId = `terminal-seller-${index}`,
      sourceInvId = `${checkoutId}-${index}`;
    const item = await prisma.item.create({
      data: {
        itemCode: sourceInvId,
        kind: 'STOCK',
        sellerIdentifier: accountId,
      },
    });
    itemIds.push(item.id);
    await prisma.movement.create({
      data: {
        itemId: item.id,
        direction: 'IN',
        reason: 'STOCKED',
        quantity: 4,
      },
    });
    lines.push({
      lineId: `line-${index}`,
      accountId,
      sourceInvId,
      quantity: 1,
    });
  }
  held = await reserveStock({
    operationId: randomUUID(),
    checkoutId,
    version: 1,
    expiresAt: new Date((await databaseNow(prisma)).getTime() + 60000).toISOString(),
    lines,
  });
});
afterEach(async () => {
  await cleanupReservationScopeFixture(checkoutId);
  await prisma.movement.deleteMany({ where: { itemId: { in: itemIds } } });
  await prisma.item.deleteMany({ where: { id: { in: itemIds } } });
});
afterAll(async () => prisma.$disconnect());
const lineage = (value: ReservationResult, index?: number) =>
  (index === undefined ? value.lines : [value.lines[index]]).map(
    ({ reservationId, lineId, revision }) => ({
      reservationId,
      lineId,
      revision,
    }),
  );
const protect = () =>
  protectReservations({
    operationId: randomUUID(),
    checkoutId,
    version: 1,
    paymentScopeId: `${checkoutId}-parent`,
    fence: 1,
    lines: lineage(held),
  });
const commitInput = (value: ReservationResult, index = 0) => ({
  operationId: randomUUID(),
  checkoutId,
  version: 1,
  scope: value.scope,
  paymentScopeId: `${checkoutId}-parent`,
  fence: 1,
  paymentId: 'synthetic-payment',
  purchaseId: 'synthetic-purchase',
  commerceSellerOrderId: `synthetic-seller-order-${index}`,
  lines: lineage(value, index),
});
const rows = () =>
  prisma.inventoryOwnerEvent.findMany({
    where: { checkoutId },
    orderBy: { scopeRevision: 'asc' },
    include: { delivery: true },
  });
it('emits both seller commit subsets with complete scope, actual operation ancestry and one delivery per change', async () => {
  const protectedHold = await protect();
  const inputs = [commitInput(protectedHold, 0), commitInput(protectedHold, 1)];
  const results = await Promise.all(inputs.map((input) => commitStock(input)));
  const events = await rows();
  expect(events.map((row) => row.scopeRevision)).toEqual([3, 4]);
  for (const row of events) {
    const event = inventoryOwnerEventSchema.parse(row.payload);
    if (event.eventKind !== 'INVENTORY_RESERVATION_COMMITTED') throw Error('Expected commit event');
    const input = inputs.find(
      (input) => input.operationId === event.commit.reservationOperationId,
    )!;
    expect(event.commit).toEqual({
      reservationOperationId: input.operationId,
      paymentId: input.paymentId,
      purchaseId: input.purchaseId,
      commerceSellerOrderId: input.commerceSellerOrderId,
      paymentScopeId: input.paymentScopeId,
      fence: 1,
    });
    expect(event.committedReservationIds).toEqual(input.lines.map((line) => line.reservationId));
    expect(event.reservation.lines).toHaveLength(2);
    expect(event.reservation.scope).toEqual({
      ...held.scope,
      revision: row.scopeRevision,
    });
    expect(row.payloadHash).toBe(workflowInputHash(event));
    expect(row.delivery?.state).toBe('PENDING');
    const operation = await prisma.reservationOperation.findUniqueOrThrow({
      where: { id: input.operationId },
    });
    expect(operation.kind).toBe('COMMIT');
    expect(row.observedAt.getTime()).toBeGreaterThanOrEqual(operation.createdAt.getTime());
  }
  expect(
    await prisma.movement.count({
      where: { itemId: { in: itemIds }, reason: 'SOLD' },
    }),
  ).toBe(2);
  expect(await prisma.inventoryCommand.count({ where: { resourceId: checkoutId } })).toBe(1);
  expect(await Promise.all(inputs.map((input) => commitStock(input)))).toEqual(results);
  expect(await rows()).toEqual(events);
});
it.each([false, true])(
  'publishes actual release metadata and no sold movements, protected=%s',
  async (protectedRelease) => {
    const value = protectedRelease ? await protect() : held;
    const financialResolution = {
      resolutionId: 'synthetic-closed-scope',
      paymentScopeId: `${checkoutId}-parent`,
      fence: 2,
      scopeClosedAt: (await databaseNow(prisma)).toISOString(),
      outcome: 'FAILED' as const,
    };
    const input = {
      operationId: randomUUID(),
      checkoutId,
      version: 1,
      cause: 'payment_failed' as const,
      lines: lineage(value),
      ...(protectedRelease ? { financialResolution } : {}),
    };
    const first = await releaseStock(input);
    expect(await releaseStock(input)).toEqual(first);
    const [row] = await rows();
    const event = inventoryOwnerEventSchema.parse(row.payload);
    if (event.eventKind !== 'INVENTORY_RESERVATION_RELEASED') throw Error('Expected release event');
    expect(event.release).toEqual({
      reservationOperationId: input.operationId,
      cause: 'payment_failed',
      financialResolution: protectedRelease ? financialResolution : null,
    });
    expect(event.releasedReservationIds).toEqual(
      held.lines.map((line) => line.reservationId).sort(),
    );
    expect(event.reservation.lines.every((line) => line.state === 'RELEASED')).toBe(true);
    expect(
      await prisma.movement.count({
        where: { itemId: { in: itemIds }, reason: 'SOLD' },
      }),
    ).toBe(0);
    expect(await rows()).toHaveLength(1);
  },
);
it.each(['inventoryOwnerEvent', 'inventoryOwnerEventOutbox'] as const)(
  'rolls stock, operation, scope revision and event back when %s write fails',
  async (stage) => {
    const value = await protect(),
      input = commitInput(value);
    const before = await prisma.movement.count({
      where: { itemId: { in: itemIds } },
    });
    await expect(
      prisma.$transaction(async (tx) => {
        const failing = new Proxy(tx, {
          get(target, key) {
            if (key === stage)
              return new Proxy(target[stage], {
                get(delegate, operation) {
                  if (operation === 'create')
                    return async () => {
                      throw Error('injected terminal write failure');
                    };
                  return Reflect.get(delegate, operation);
                },
              });
            return Reflect.get(target, key);
          },
        });
        return commitStock(input, failing);
      }),
    ).rejects.toThrow('injected terminal write failure');
    expect(await prisma.movement.count({ where: { itemId: { in: itemIds } } })).toBe(before);
    expect(await rows()).toEqual([]);
    expect(
      await prisma.reservationOperation.findUnique({
        where: { id: input.operationId },
      }),
    ).toBeNull();
    expect(
      await prisma.inventoryReserveScope.findUniqueOrThrow({
        where: { id: held.scope.id },
      }),
    ).toMatchObject({ revision: 2 });
    expect(
      await prisma.stockReservation.count({
        where: { checkoutId, state: 'PAYMENT_LOCKED' },
      }),
    ).toBe(2);
  },
);
it('commit and closed-scope release racing for the same subset produce one terminal fact only', async () => {
  const value = await protect(),
    commit = commitInput(value);
  const release = {
    operationId: randomUUID(),
    checkoutId,
    version: 1,
    cause: 'cancelled' as const,
    lines: lineage(value, 0),
    financialResolution: {
      resolutionId: 'synthetic-close',
      paymentScopeId: `${checkoutId}-parent`,
      fence: 2,
      scopeClosedAt: (await databaseNow(prisma)).toISOString(),
      outcome: 'CANCELLED' as const,
    },
  };
  const result = await Promise.allSettled([commitStock(commit), releaseStock(release)]);
  expect(result.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
  expect(await rows()).toHaveLength(1);
  expect(
    await prisma.movement.count({
      where: { itemId: itemIds[0], reason: 'RELEASED' },
    }),
  ).toBe(1);
});
it('a no-op expiry scan creates no terminal owner event for protected lines', async () => {
  await protect();
  expect((await expireStockReservations()).expiredReservationCount).toBe(0);
  expect(await rows()).toEqual([]);
});
