require('../helpers/purchaseTestEnvironment.cjs');
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import prisma from '@/lib/prismaInventory';
import { databaseNow } from '@/inventory/services/stockReservationShared';
import { consumeInventoryCommand } from '@/inventory/services/workflows/inventoryCommandService';
import { expireStockReservations } from '@/inventory/services/stockReservationExpiryService';
import { protectReservations } from '@/inventory/services/reservationProtectionService';
import { releaseStock } from '@/inventory/services/stockReleaseService';
import {
  claimInventoryOwnerEvent,
  publishInventoryOwnerEvents,
  settleInventoryOwnerEvent,
} from '@/inventory/services/workflows/inventoryOwnerEventPublisher';
import { inventoryOwnerEventSchema } from '@/inventory/types/inventoryOwnerEvent';
import { workflowInputHash } from '@/inventory/services/workflows/workflowIdentity';
import { commandEnvelope } from '../helpers/inventoryWorkflowFixtures';
import { cleanupReservationScopeFixture } from '../helpers/reserveThroughOwner';

// Explicit short synthetic fixture lifetime, not a runtime reservation default.
const SYNTHETIC_EXPIRY_MS = 750;
let checkoutId: string,
  itemIds: number[],
  deadline: Date,
  original: ReturnType<typeof commandEnvelope>,
  held: any;
beforeEach(async () => {
  checkoutId = `owner-expiry-${randomUUID()}`;
  itemIds = [];
  for (let index = 0; index < 3; index++) {
    const item = await prisma.item.create({
      data: {
        itemCode: `${checkoutId}-${index}`,
        kind: 'STOCK',
        sellerIdentifier: 'owner-event-seller',
      },
    });
    itemIds.push(item.id);
    await prisma.movement.create({
      data: { itemId: item.id, direction: 'IN', reason: 'STOCKED', quantity: 2 },
    });
  }
  deadline = new Date((await databaseNow(prisma)).getTime() + SYNTHETIC_EXPIRY_MS);
  original = commandEnvelope('INVENTORY_RESERVE', {
    checkoutId,
    version: 1,
    expiresAt: deadline.toISOString(),
    lines: itemIds.map((_, index) => ({
      lineId: `line-${index}`,
      sourceInvId: `${checkoutId}-${index}`,
      accountId: 'owner-event-seller',
      quantity: 1,
    })),
  });
  held = (await consumeInventoryCommand(original, 'commerce')).result;
});
afterEach(async () => {
  jest.restoreAllMocks();
  await cleanupReservationScopeFixture(checkoutId);
  await prisma.movement.deleteMany({ where: { itemId: { in: itemIds } } });
  await prisma.item.deleteMany({ where: { id: { in: itemIds } } });
});
afterAll(async () => prisma.$disconnect());
const elapsed = async () => {
  await prisma.$queryRaw`SELECT 1 AS waited FROM pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM (${deadline}::timestamptz - clock_timestamp())) + 0.005))`;
};
const events = () =>
  prisma.inventoryOwnerEvent.findMany({
    where: { checkoutId },
    orderBy: { scopeRevision: 'asc' },
    include: { delivery: true },
  });
const lineage = () =>
  held.lines.map((line: any) => ({
    reservationId: line.reservationId,
    lineId: line.lineId,
    revision: line.revision,
  }));
const failTransactionWrite = (method: 'create' | 'updateMany') => {
  const transact = prisma.$transaction.bind(prisma) as any;
  return jest.spyOn(prisma, '$transaction').mockImplementation(((work: any, ...rest: any[]) =>
    transact(
      (tx: any) =>
        work(
          new Proxy(tx, {
            get(target, key) {
              if (key === 'inventoryOwnerEventOutbox')
                return new Proxy(target[key], {
                  get(delegate, operation) {
                    if (operation === method)
                      return async () => {
                        throw new Error('injected owner delivery failure');
                      };
                    return Reflect.get(delegate, operation);
                  },
                });
              return Reflect.get(target, key);
            },
          }),
        ),
      ...rest,
    )) as any);
};
it('commits each expiry with full scope evidence, monotonic revisions and no fabricated inbox receipt', async () => {
  const commandBefore = await prisma.inventoryCommand.findUniqueOrThrow({
    where: { operationId: original.operationId },
  });
  await elapsed();
  expect((await expireStockReservations()).expiredReservationCount).toBe(3);
  const rows = await events();
  expect(rows.map((row) => row.scopeRevision)).toEqual([2, 3, 4]);
  for (const [index, row] of rows.entries()) {
    const event = inventoryOwnerEventSchema.parse(row.payload);
    expect(row.id).toBe(`${held.scope.id}:revision:${index + 2}`);
    expect(event.reservation.scope).toEqual({ ...held.scope, revision: index + 2 });
    expect(event.reservation.lines).toHaveLength(3);
    expect(event.expiredReservationIds).toHaveLength(1);
    expect(event.reservation.lines.filter((line) => line.state === 'EXPIRED')).toHaveLength(
      index + 1,
    );
    expect(row.payloadHash).toBe(workflowInputHash(event));
    expect(row.delivery?.state).toBe('PENDING');
    expect(row.observedAt.getTime()).toBeGreaterThanOrEqual(deadline.getTime());
    const expired = await prisma.stockReservation.findUniqueOrThrow({
      where: { id: event.expiredReservationIds[0] },
    });
    expect(row.observedAt.getTime()).toBeGreaterThanOrEqual(expired.updatedAt.getTime());
  }
  expect((await expireStockReservations()).expiredReservationCount).toBe(0);
  expect(await consumeInventoryCommand(original, 'commerce')).toEqual(commandBefore.result);
  expect(await prisma.inventoryCommand.count({ where: { resourceId: checkoutId } })).toBe(1);
  expect(
    await prisma.inventoryInboxEvent.count({ where: { operationId: original.operationId } }),
  ).toBe(1);
  expect(
    await prisma.inventoryResultOutbox.count({ where: { operationId: original.operationId } }),
  ).toBe(1);
  expect(await events()).toEqual(rows);
});
it('serializes duplicate expiry scans into one release and owner event per transitioned line', async () => {
  await elapsed();
  const outcomes = await Promise.all([expireStockReservations(), expireStockReservations()]);
  expect(outcomes.reduce((sum, result) => sum + result.expiredReservationCount, 0)).toBe(3);
  expect(
    await prisma.movement.count({ where: { itemId: { in: itemIds }, reason: 'RELEASED' } }),
  ).toBe(3);
  expect(await events()).toHaveLength(3);
});
it('retains an already released subset without reporting it as a new expiry', async () => {
  await releaseStock({
    operationId: randomUUID(),
    checkoutId,
    version: 1,
    cause: 'cancelled',
    lines: [lineage()[0]],
  });
  await elapsed();
  expect((await expireStockReservations()).expiredReservationCount).toBe(2);
  const rows = await events();
  expect(rows.map((row) => row.scopeRevision)).toEqual([3, 4]);
  for (const row of rows) {
    const event = inventoryOwnerEventSchema.parse(row.payload);
    expect(event.expiredReservationIds).not.toContain(held.lines[0].reservationId);
    expect(
      event.reservation.lines.find((line) => line.reservationId === held.lines[0].reservationId)
        ?.state,
    ).toBe('RELEASED');
  }
});
it('never expires protected reservations or creates a false owner event', async () => {
  await protectReservations({
    operationId: randomUUID(),
    checkoutId,
    version: 1,
    paymentScopeId: 'protected-scope',
    fence: 1,
    lines: lineage(),
  });
  await elapsed();
  expect((await expireStockReservations()).expiredReservationCount).toBe(0);
  expect(await events()).toEqual([]);
  expect(
    await prisma.stockReservation.count({ where: { checkoutId, state: 'PAYMENT_LOCKED' } }),
  ).toBe(3);
});
it('rolls expiry movement, revision, immutable event and domain operation back when outbox creation fails', async () => {
  await elapsed();
  const fault = failTransactionWrite('create');
  try {
    await expect(expireStockReservations()).rejects.toThrow('injected owner delivery failure');
  } finally {
    fault.mockRestore();
  }
  expect(await events()).toEqual([]);
  expect(await prisma.stockReservation.count({ where: { checkoutId, state: 'HELD' } })).toBe(3);
  expect(
    await prisma.movement.count({ where: { itemId: { in: itemIds }, reason: 'RELEASED' } }),
  ).toBe(0);
  expect(await prisma.reservationOperation.count({ where: { checkoutId, kind: 'EXPIRE' } })).toBe(
    0,
  );
  expect(
    (
      await prisma.inventoryReserveScope.findUniqueOrThrow({
        where: { checkoutId_checkoutVersion: { checkoutId, checkoutVersion: 1 } },
      })
    ).revision,
  ).toBe(1);
  expect((await expireStockReservations()).expiredReservationCount).toBe(3);
  expect(await events()).toHaveLength(3);
});
it('retries the exact immutable event after send acceptance followed by lost database acknowledgement', async () => {
  await elapsed();
  await expireStockReservations();
  const sent: string[] = [];
  const send = async (row: any) => {
    sent.push(row.eventId);
  };
  const fault = failTransactionWrite('updateMany');
  try {
    await expect(publishInventoryOwnerEvents(send)).rejects.toThrow(
      'injected owner delivery failure',
    );
  } finally {
    fault.mockRestore();
  }
  expect(sent).toHaveLength(1);
  const delivery = await prisma.inventoryOwnerEventOutbox.findUniqueOrThrow({
    where: { eventId: sent[0] },
  });
  expect(delivery.state).toBe('SENDING');
  await prisma.inventoryOwnerEventOutbox.update({
    where: { id: delivery.id },
    data: { leaseExpiresAt: new Date('2000-01-01') },
  });
  expect(await publishInventoryOwnerEvents(send)).toEqual({ delivered: 3 });
  expect(sent.filter((id) => id === delivery.eventId)).toHaveLength(2);
  expect(await events()).toHaveLength(3);
});
it('rejects a stale settlement fence and records assigned owner-event recovery when delivery is exhausted', async () => {
  await elapsed();
  await expireStockReservations();
  const first = await claimInventoryOwnerEvent();
  if (!first || 'exhausted' in first) throw new Error('missing claim');
  await prisma.inventoryOwnerEventOutbox.update({
    where: { id: first.id },
    data: { leaseExpiresAt: new Date('2000-01-01') },
  });
  const replacement = await claimInventoryOwnerEvent();
  if (!replacement || 'exhausted' in replacement) throw new Error('missing replacement');
  await expect(settleInventoryOwnerEvent(first, true)).rejects.toThrow('STALE_DELIVERY');
  await prisma.inventoryOwnerEventOutbox.update({
    where: { id: replacement.id },
    data: { attempts: 8 },
  });
  await settleInventoryOwnerEvent({ ...replacement, attempts: 8 }, false);
  expect(
    await prisma.inventoryOwnerEventRecovery.findUnique({
      where: {
        eventId_reason: {
          eventId: replacement.eventId,
          reason: 'INVENTORY_RESULT_DELIVERY_EXHAUSTED',
        },
      },
    }),
  ).toMatchObject({
    assignedOwner: 'inventory-operations',
    severity: 'HIGH',
    nextAction: 'REDELIVER_OWNER_EVENT',
    resolvedAt: null,
  });
  expect((await events()).map((row) => row.payloadHash)).toEqual(
    (await events()).map((row) => workflowInputHash(row.payload)),
  );
});
it('restricts scope/event deletion and prevents mismatched checkout identity through the composite FK', async () => {
  await elapsed();
  await expireStockReservations();
  const [row] = await events();
  await expect(
    prisma.inventoryOwnerEvent.create({
      data: {
        id: 'wrong-' + randomUUID(),
        scopeId: row.scopeId,
        scopeRevision: 99,
        checkoutId: 'wrong',
        checkoutVersion: 1,
        kind: row.kind,
        observedAt: row.observedAt,
        payload: row.payload!,
        payloadHash: row.payloadHash,
      },
    }),
  ).rejects.toMatchObject({ code: 'P2003' });
  await expect(prisma.inventoryOwnerEvent.delete({ where: { id: row.id } })).rejects.toMatchObject({
    code: 'P2003',
  });
  await expect(
    prisma.inventoryReserveScope.delete({ where: { id: row.scopeId } }),
  ).rejects.toMatchObject({ code: 'P2003' });
});
