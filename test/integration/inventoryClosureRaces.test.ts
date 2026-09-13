require('../helpers/purchaseTestEnvironment.cjs');
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, expect, it } from '@jest/globals';
import prisma from '@/lib/prismaInventory';
import { reserveStock, cleanupReservationScopeFixture } from '../helpers/reserveThroughOwner';
import { commandEnvelope } from '../helpers/inventoryWorkflowFixtures';
import { protectReservations } from '@/inventory/services/reservationProtectionService';
import { releaseStock } from '@/inventory/services/stockReleaseService';
import { commitStock } from '@/inventory/services/stockCommitService';
import {
  databaseNow,
  lockReservationScope,
  type InventoryStockTransaction,
} from '@/inventory/services/stockReservationShared';
import {
  consumeInventoryCommand,
  consumeInventoryCommandInTransaction,
} from '@/inventory/services/workflows/inventoryCommandService';
import { originalReserveDescriptorSchema } from '@/inventory/types/inventoryReserveScope';
import { inventoryOwnerEventSchema } from '@/inventory/types/inventoryOwnerEvent';
import type { ReservationResult } from '@/inventory/types/stockReservationCommands';

let checkoutId: string, itemIds: number[], held: ReservationResult;
beforeEach(async () => {
  checkoutId = `closure-race-${randomUUID()}`;
  itemIds = [];
  const lines = [];
  for (let index = 0; index < 2; index++) {
    const accountId = `closure-seller-${index}`,
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
const protectInput = () => ({
  operationId: randomUUID(),
  checkoutId,
  version: 1,
  paymentScopeId: `${checkoutId}-parent`,
  fence: 1,
  lines: lineage(held),
});
const releaseInput = (value: ReservationResult, index?: number) => ({
  operationId: randomUUID(),
  checkoutId,
  version: 1,
  cause: 'cancelled' as const,
  lines: lineage(value, index),
});
const financialResolution = async () => ({
  resolutionId: `${checkoutId}-synthetic-resolution`,
  paymentScopeId: `${checkoutId}-parent`,
  fence: 2,
  scopeClosedAt: (await databaseNow(prisma)).toISOString(),
  outcome: 'CANCELLED' as const,
});
const observe = () =>
  consumeInventoryCommand(
    commandEnvelope('INVENTORY_OBSERVE', {
      checkoutId,
      version: 1,
      reserveOperationId: held.scope.reserveOperationId,
      reserveOperationInputHash: held.scope.reserveOperationInputHash,
      reserveInputHash: held.scope.reserveInputHash,
    }),
    'commerce',
  );
const events = async () =>
  (
    await prisma.inventoryOwnerEvent.findMany({
      where: { checkoutId },
      orderBy: { scopeRevision: 'asc' },
    })
  ).map((row) => inventoryOwnerEventSchema.parse(row.payload));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
// Two real transaction connections: the first owns the scope lock; PostgreSQL must
// report the second blocked by that exact backend before the first mutates anything.
// Polling catalog state is bounded and uses no timing sleeps or mocked transactions.
const orderedRace = async <A, B>(
  first: (tx: InventoryStockTransaction) => Promise<A>,
  second: (tx: InventoryStockTransaction) => Promise<B>,
) => {
  const owner = deferred<number>(),
    contender = deferred<number>();
  const firstResult = prisma.$transaction(
    async (tx) => {
      await lockReservationScope(tx, checkoutId, 1);
      const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      owner.resolve(pid);
      const secondPid = await contender.promise;
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < deadline) {
        const [state] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
        SELECT ${pid} = ANY(pg_blocking_pids(${secondPid}::int)) AS blocked`;
        if (state.blocked) {
          blocked = true;
          break;
        }
      }
      expect(blocked).toBe(true);
      return first(tx);
    },
    { timeout: 10000 },
  );
  const secondResult = prisma.$transaction(
    async (tx) => {
      await owner.promise;
      const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      contender.resolve(pid);
      return second(tx);
    },
    { timeout: 10000 },
  );
  return Promise.allSettled([firstResult, secondResult]);
};

it('CLOSE observes HELD while delayed PROTECT waits, then fresh observation sees protection and CLOSE replay stays historical', async () => {
  const stored = await prisma.inventoryReserveScope.findUniqueOrThrow({
    where: { id: held.scope.id },
  });
  const close = commandEnvelope('INVENTORY_CLOSE_RESERVE', {
    checkoutId,
    version: 1,
    originalReserve: originalReserveDescriptorSchema.parse(stored.originalDescriptor),
    reason: 'CANCELLED',
  });
  const results = await orderedRace(
    (tx) => consumeInventoryCommandInTransaction(tx, close, 'commerce'),
    (tx) => protectReservations(protectInput(), tx),
  );
  expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
  if (results[0].status !== 'fulfilled') throw Error('Expected close observation');
  const historical = results[0].value;
  expect(historical).toMatchObject({
    outcome: 'SUCCEEDED',
    result: {
      evidenceKind: 'CURRENT_RESERVATION',
      reservation: {
        scope: held.scope,
        lines: held.lines.map((line) => ({
          reservationId: line.reservationId,
          state: 'HELD',
          revision: 0,
        })),
      },
    },
  });
  expect(await consumeInventoryCommand({ ...close, eventId: randomUUID() }, 'commerce')).toEqual(
    historical,
  );
  expect(await observe()).toMatchObject({
    outcome: 'SUCCEEDED',
    result: {
      evidenceKind: 'CURRENT_RESERVATION',
      reservation: {
        scope: { ...held.scope, revision: 2 },
        lines: held.lines.map((line) => ({
          reservationId: line.reservationId,
          state: 'PAYMENT_LOCKED',
          revision: 1,
          fence: 1,
        })),
      },
    },
  });
  expect(
    await prisma.inventoryReserveNoEffectClosure.count({
      where: { scopeId: held.scope.id },
    }),
  ).toBe(0);
  expect(await events()).toEqual([]);
});

it.each(['PROTECT', 'RELEASE'] as const)(
  '%s wins the scope lock against the competing HELD transition without partial stock effects',
  async (winner) => {
    const protection = protectInput(),
      release = releaseInput(held);
    const protect = (tx: InventoryStockTransaction) => protectReservations(protection, tx);
    const releaseHeld = (tx: InventoryStockTransaction) => releaseStock(release, tx);
    const results = await orderedRace(
      winner === 'PROTECT' ? protect : releaseHeld,
      winner === 'PROTECT' ? releaseHeld : protect,
    );
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: { message: 'Reservation revision stale' },
    });
    const state = winner === 'PROTECT' ? 'PAYMENT_LOCKED' : 'RELEASED';
    expect(await observe()).toMatchObject({
      outcome: 'SUCCEEDED',
      result: {
        reservation: {
          scope: { ...held.scope, revision: 2 },
          lines: held.lines.map(() => ({ state, revision: 1 })),
        },
      },
    });
    expect(
      await prisma.reservationOperation.findUnique({
        where: {
          id: winner === 'PROTECT' ? release.operationId : protection.operationId,
        },
      }),
    ).toBeNull();
    expect(
      await prisma.movement.count({
        where: { itemId: { in: itemIds }, reason: 'RELEASED' },
      }),
    ).toBe(winner === 'RELEASE' ? 2 : 0);
    expect(
      await prisma.movement.count({
        where: { itemId: { in: itemIds }, reason: 'SOLD' },
      }),
    ).toBe(0);
    expect(await events()).toHaveLength(winner === 'RELEASE' ? 1 : 0);
  },
);

it('a stale subset containing a terminal line rolls back atomically and a fresh remaining subset releases once', async () => {
  const first = await releaseStock(releaseInput(held, 0));
  // Put the still-live line first: rejecting the later stale member must leave it untouched.
  const stale = { ...releaseInput(held), lines: lineage(held).reverse() };
  const before = await prisma.movement.count({
    where: { itemId: { in: itemIds } },
  });
  await expect(releaseStock(stale)).rejects.toThrow('Reservation revision stale');
  expect(await prisma.movement.count({ where: { itemId: { in: itemIds } } })).toBe(before);
  expect(
    await prisma.reservationOperation.findUnique({
      where: { id: stale.operationId },
    }),
  ).toBeNull();
  expect(await events()).toHaveLength(1);
  const current = await observe();
  if (
    current.outcome !== 'SUCCEEDED' ||
    !('evidenceKind' in current.result) ||
    current.result.evidenceKind !== 'CURRENT_RESERVATION'
  )
    throw Error('Expected current full observation');
  expect(current.result.reservation.scope).toEqual(first.scope);
  const remaining = current.result.reservation.lines.filter((line) => line.state === 'HELD');
  expect(remaining).toHaveLength(1);
  const input = {
    ...releaseInput(held),
    lines: lineage({ ...current.result.reservation, lines: remaining }),
  };
  const released = await releaseStock(input);
  expect(await releaseStock(input)).toEqual(released);
  expect(released.scope).toEqual({ ...held.scope, revision: 3 });
  const emitted = await events();
  expect(emitted).toHaveLength(2);
  expect(
    emitted.map((event) =>
      event.eventKind === 'INVENTORY_RESERVATION_RELEASED' ? event.releasedReservationIds : [],
    ),
  ).toEqual([[held.lines[0].reservationId], [held.lines[1].reservationId]]);
  expect(emitted[1].reservation.lines.every((line) => line.state === 'RELEASED')).toBe(true);
  expect(
    await prisma.movement.count({
      where: { itemId: { in: itemIds }, reason: 'RELEASED' },
    }),
  ).toBe(2);
});

it.each(['RELEASE', 'COMMIT'] as const)(
  'disjoint %s first preserves per-line payment fences and coherent full-scope terminal events',
  async (winner) => {
    const protectedHold = await protectReservations(protectInput());
    // Synthetic financial assertion exercises Inventory's trusted-owner boundary;
    // it is not evidence that Commerce may cancel a payment which funded another seller.
    const release = {
      ...releaseInput(protectedHold, 0),
      financialResolution: await financialResolution(),
    };
    const commit = {
      operationId: randomUUID(),
      checkoutId,
      version: 1,
      scope: protectedHold.scope,
      paymentScopeId: `${checkoutId}-parent`,
      fence: 1,
      paymentId: 'synthetic-payment',
      purchaseId: 'synthetic-purchase',
      commerceSellerOrderId: 'synthetic-seller-order',
      lines: lineage(protectedHold, 1),
    };
    const releaseSubset = (tx: InventoryStockTransaction) => releaseStock(release, tx);
    const commitSubset = (tx: InventoryStockTransaction) => commitStock(commit, tx);
    const results = await orderedRace(
      winner === 'RELEASE' ? releaseSubset : commitSubset,
      winner === 'RELEASE' ? commitSubset : releaseSubset,
    );
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    const emitted = await events();
    expect(emitted.map((event) => event.reservation.scope)).toEqual(
      [3, 4].map((revision) => ({ ...held.scope, revision })),
    );
    const releaseEvent = emitted.find(
      (event) => event.eventKind === 'INVENTORY_RESERVATION_RELEASED',
    );
    const commitEvent = emitted.find(
      (event) => event.eventKind === 'INVENTORY_RESERVATION_COMMITTED',
    );
    expect(releaseEvent).toMatchObject({
      releasedReservationIds: [held.lines[0].reservationId],
      release: {
        reservationOperationId: release.operationId,
        financialResolution: release.financialResolution,
      },
    });
    expect(commitEvent).toMatchObject({
      committedReservationIds: [held.lines[1].reservationId],
      commit: {
        reservationOperationId: commit.operationId,
        paymentScopeId: commit.paymentScopeId,
        fence: 1,
      },
    });
    expect(
      emitted[0].reservation.lines.filter((line) => line.state === 'PAYMENT_LOCKED'),
    ).toHaveLength(1);
    expect(emitted[1].reservation.lines).toMatchObject([
      {
        reservationId: held.lines[0].reservationId,
        state: 'RELEASED',
        fence: 2,
        revision: 2,
        soldMovementId: null,
      },
      {
        reservationId: held.lines[1].reservationId,
        state: 'COMMITTED',
        fence: 1,
        revision: 2,
      },
    ]);
    expect(await observe()).toMatchObject({
      outcome: 'SUCCEEDED',
      result: { reservation: emitted[1].reservation },
    });
    const snapshots = results.map((result) => {
      if (result.status !== 'fulfilled') throw Error('Expected subset success');
      return result.value;
    });
    expect(await releaseStock(release)).toEqual(snapshots[winner === 'RELEASE' ? 0 : 1]);
    expect(await commitStock(commit)).toEqual(snapshots[winner === 'COMMIT' ? 0 : 1]);
    expect(await events()).toEqual(emitted);
    expect(
      await prisma.inventoryOwnerEventOutbox.count({
        where: { event: { checkoutId } },
      }),
    ).toBe(2);
    expect(
      await prisma.movement.count({
        where: { itemId: { in: itemIds }, reason: 'RELEASED' },
      }),
    ).toBe(2);
    expect(
      await prisma.movement.count({
        where: { itemId: { in: itemIds }, reason: 'SOLD' },
      }),
    ).toBe(1);
  },
);
