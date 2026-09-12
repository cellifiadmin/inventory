require('../helpers/purchaseTestEnvironment.cjs');
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import prisma from '@/lib/prismaInventory';
import { databaseNow } from '@/inventory/services/stockReservationShared';
import {
  consumeInventoryCommand,
  consumeInventoryCommandInTransaction,
} from '@/inventory/services/workflows/inventoryCommandService';
import { workflowInputHash } from '@/inventory/services/workflows/workflowIdentity';
import { commandEnvelope, rehashCommand } from '../helpers/inventoryWorkflowFixtures';
import { SYNTHETIC_HOLD_DURATION_MS } from '../helpers/reservationFixtures';

describe('one immutable reserve scope and authoritative observations in PostgreSQL', () => {
  let itemId: number, checkoutId: string, original: ReturnType<typeof commandEnvelope>;
  const db = prisma as any;
  beforeEach(async () => {
    checkoutId = `scope-test-${randomUUID()}`;
    itemId = (
      await prisma.item.create({
        data: { itemCode: checkoutId, kind: 'STOCK', sellerIdentifier: 'scope-seller' },
      })
    ).id;
    await prisma.movement.create({
      data: { itemId, direction: 'IN', reason: 'STOCKED', quantity: 2 },
    });
    original = commandEnvelope('INVENTORY_RESERVE', {
      checkoutId,
      version: 1,
      expiresAt: new Date(
        (await databaseNow(prisma)).getTime() + SYNTHETIC_HOLD_DURATION_MS,
      ).toISOString(),
      lines: [{ lineId: 'line', accountId: 'scope-seller', sourceInvId: checkoutId, quantity: 1 }],
    });
  });
  afterEach(async () => {
    const ids = (
      await prisma.inventoryCommand.findMany({
        where: {
          OR: [
            { resourceId: checkoutId },
            { immutableEnvelope: { path: ['input', 'checkoutId'], equals: checkoutId } },
          ],
        },
      })
    ).map((row) => row.operationId);
    await prisma.inventoryOwnerEventRecovery.deleteMany({ where: { event: { checkoutId } } });
    await prisma.inventoryOwnerEventOutbox.deleteMany({ where: { event: { checkoutId } } });
    await prisma.inventoryOwnerEvent.deleteMany({ where: { checkoutId } });
    await prisma.inventoryResultOutbox.deleteMany({ where: { operationId: { in: ids } } });
    await prisma.inventoryInboxEvent.deleteMany({ where: { operationId: { in: ids } } });
    await prisma.inventoryCommandRecovery.deleteMany({ where: { operationId: { in: ids } } });
    await db.inventoryReserveNoEffectClosure.deleteMany({ where: { scope: { checkoutId } } });
    await prisma.stockReservation.deleteMany({ where: { itemId } });
    await prisma.reservationOperation.deleteMany({ where: { checkoutId } });
    await db.inventoryReserveScopeLine.deleteMany({ where: { checkoutId } });
    await db.inventoryReserveScope.deleteMany({ where: { checkoutId } });
    await prisma.inventoryCommand.deleteMany({ where: { operationId: { in: ids } } });
    await prisma.movement.deleteMany({ where: { itemId } });
    await prisma.item.delete({ where: { id: itemId } });
  });
  afterAll(async () => prisma.$disconnect());
  const consume = (event: unknown = original) => consumeInventoryCommand(event, 'commerce');
  const request = (command: string, input: unknown) =>
    rehashCommand({
      ...original,
      eventId: randomUUID(),
      operationId: randomUUID(),
      deadlineAt: new Date(Date.now() + SYNTHETIC_HOLD_DURATION_MS).toISOString(),
      command,
      stepKey: command,
      input,
    } as any);
  const observe = () =>
    request('INVENTORY_OBSERVE', {
      checkoutId,
      version: 1,
      reserveOperationId: original.operationId,
      reserveOperationInputHash: original.operationInputHash,
      reserveInputHash: workflowInputHash(original.input),
    });
  const close = () => {
    const { eventId: _eventId, ...originalReserve } = original;
    return request('INVENTORY_CLOSE_RESERVE', {
      checkoutId,
      version: 1,
      originalReserve,
      reason: 'CANCELLED',
    });
  };
  it('keeps absent reserve evidence unknown and does not create a scope tombstone', async () => {
    expect(await consume(observe())).toMatchObject({
      outcome: 'UNKNOWN',
      result: { recoveryRequired: true },
    });
    expect(await db.inventoryReserveScope.count({ where: { checkoutId } })).toBe(0);
    expect(await prisma.stockReservation.count({ where: { itemId } })).toBe(0);
  });
  it('closes an unseen reserve with owner authority, then prevents both late original and different-ID effects', async () => {
    const closed = await consume(close());
    expect(closed).toMatchObject({
      outcome: 'SUCCEEDED',
      result: { evidenceKind: 'CLOSED_NO_EFFECT' },
    });
    expect(
      await prisma.inventoryCommand.findUnique({ where: { operationId: original.operationId } }),
    ).toBeNull();
    expect(await prisma.inventoryInboxEvent.count({ where: { eventId: original.eventId } })).toBe(
      0,
    );
    const late = await consume();
    expect(late).toMatchObject({
      outcome: 'FAILED',
      result: { noEffect: { kind: 'RESERVE_SCOPE_CLOSED_NO_EFFECT' } },
    });
    expect(await consume()).toEqual(late);
    const different = await consume(
      rehashCommand({ ...original, eventId: randomUUID(), operationId: randomUUID() }),
    );
    expect(different).toMatchObject({ outcome: 'FAILED', result: { noEffect: null } });
    expect(await prisma.stockReservation.count({ where: { itemId } })).toBe(0);
    expect(await prisma.movement.count({ where: { itemId, reason: 'RESERVED' } })).toBe(0);
    expect(
      await db.inventoryReserveNoEffectClosure.count({ where: { scope: { checkoutId } } }),
    ).toBe(1);
  });
  it('returns a new closure observation after the actual persisted database timestamp', async () => {
    const closing = close();
    const result = await prisma.$transaction((transaction) => {
      const advancingClock = new Proxy(transaction, {
        get(target, key) {
          if (key !== '$queryRaw') return Reflect.get(target, key);
          return async (sql: TemplateStringsArray, ...values: unknown[]) => {
            const actual = await target.$queryRaw(sql, ...values);
            if (sql.join('').includes('clock_timestamp')) {
              // Separate actual PG clock reads deterministically without inventing provider/DB values.
              await target.$queryRaw`SELECT 1 FROM pg_sleep(0.01)`;
            }
            return actual;
          };
        },
      });
      return consumeInventoryCommandInTransaction(advancingClock, closing, 'commerce');
    });
    if (result.outcome !== 'SUCCEEDED' || !('evidenceKind' in result.result) || result.result.evidenceKind !== 'CLOSED_NO_EFFECT') {
      throw new Error('fixture expected authoritative no-effect closure');
    }
    const evidence = result.result;
    const persisted = await prisma.inventoryReserveNoEffectClosure.findUniqueOrThrow({ where: { id: evidence.proof.closure.id } });
    expect(evidence.proof.closure.closedAt).toBe(persisted.closedAt.toISOString());
    // This is the same temporal invariant enforced by Commerce's reservation projection.
    expect(new Date(evidence.observedAt).getTime()).toBeGreaterThanOrEqual(persisted.closedAt.getTime());
    expect(await consume(closing)).toEqual(result);
    expect(await prisma.stockReservation.count({ where: { itemId } })).toBe(0);
  });
  it('persists no-effect proof for a known all-or-nothing reserve failure and forbids later stock replenishment reopening', async () => {
    if (original.command !== 'INVENTORY_RESERVE') throw new Error('fixture');
    original = rehashCommand({
      ...original,
      input: { ...original.input, lines: [{ ...original.input.lines[0], quantity: 3 }] },
    });
    const failed = await consume();
    expect(failed).toMatchObject({
      outcome: 'FAILED',
      result: { noEffect: { lines: [{ quantity: 3 }] } },
    });
    await prisma.movement.create({
      data: { itemId, direction: 'IN', reason: 'STOCKED', quantity: 3 },
    });
    expect(await consume()).toEqual(failed);
    expect(
      await consume(
        rehashCommand({ ...original, eventId: randomUUID(), operationId: randomUUID() }),
      ),
    ).toMatchObject({ outcome: 'FAILED', result: { noEffect: null } });
    expect(await prisma.stockReservation.count({ where: { itemId } })).toBe(0);
  });
  it('makes reserve versus close choose either one hold or one immutable no-effect closure', async () => {
    const results = await Promise.allSettled([consume(), consume(close())]);
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    const held = await prisma.stockReservation.count({ where: { itemId } });
    const closures = await db.inventoryReserveNoEffectClosure.count({
      where: { scope: { checkoutId } },
    });
    expect(held + closures).toBe(1);
    expect(await consume(observe())).toMatchObject({
      outcome: 'SUCCEEDED',
      result: {
        evidenceKind: held ? 'CURRENT_RESERVATION' : 'CLOSED_NO_EFFECT',
      },
    });
  });
  it('replays an observation historically while a fresh operation observes the later atomic protected set', async () => {
    const held = await consume();
    if (held.outcome !== 'SUCCEEDED') throw new Error('fixture');
    const firstRequest = observe();
    const first = await consume(firstRequest);
    expect(first).toMatchObject({
      result: { reservation: { scope: { revision: 1 }, lines: [{ state: 'HELD' }] } },
    });
    const reservation = held.result as any;
    await consume(
      request('INVENTORY_PROTECT', {
        checkoutId,
        version: 1,
        paymentScopeId: 'scope-payment',
        fence: 1,
        lines: reservation.lines.map(({ reservationId, lineId, revision }: any) => ({
          reservationId,
          lineId,
          revision,
        })),
      }),
    );
    expect(await consume(firstRequest)).toEqual(first);
    expect(await consume(observe())).toMatchObject({
      result: { reservation: { scope: { revision: 2 }, lines: [{ state: 'PAYMENT_LOCKED' }] } },
    });
    expect(await consume()).toEqual(held);
  });
  it.each(['deadline', 'expiry'])(
    'creates a permanent no-effect tombstone for the original elapsed %s',
    async (field) => {
      if (original.command !== 'INVENTORY_RESERVE') throw new Error('fixture');
      original = rehashCommand({
        ...original,
        ...(field === 'deadline'
          ? { deadlineAt: '2000-01-01T00:00:00.000Z' }
          : { input: { ...original.input, expiresAt: '2000-01-01T00:00:00.000Z' } }),
      });
      const failed = await consume();
      expect(failed).toMatchObject({
        outcome: 'FAILED',
        result: {
          noEffect: {
            closure: {
              reason: field === 'deadline' ? 'RESERVE_DEADLINE_EXPIRED' : 'RESERVE_EXPIRED',
              authorizingOperationId: original.operationId,
            },
          },
        },
      });
      expect(await consume()).toEqual(failed);
      expect(await consume(close())).toMatchObject({
        result: { evidenceKind: 'CLOSED_NO_EFFECT', proof: (failed.result as any).noEffect },
      });
      expect(await prisma.stockReservation.count({ where: { itemId } })).toBe(0);
    },
  );
  it('atomically rolls back closure, original binding and inbox when durable result creation fails', async () => {
    const closing = close();
    await expect(
      prisma.$transaction((tx) => {
        const failing = new Proxy(tx, {
          get(target, key) {
            if (key !== 'inventoryResultOutbox') return Reflect.get(target, key);
            return {
              create: async () => {
                throw new Error('outbox crash');
              },
            };
          },
        });
        return consumeInventoryCommandInTransaction(failing, closing, 'commerce');
      }),
    ).rejects.toThrow('outbox crash');
    expect(await db.inventoryReserveScope.count({ where: { checkoutId } })).toBe(0);
    expect(await prisma.inventoryCommand.count({ where: { resourceId: checkoutId } })).toBe(0);
    expect(
      await prisma.inventoryInboxEvent.count({ where: { operationId: closing.operationId } }),
    ).toBe(0);
    expect(await consume(closing)).toMatchObject({ result: { evidenceKind: 'CLOSED_NO_EFFECT' } });
  });
  it('rejects foreign observation hashes without changing the held scope or granting no-effect proof', async () => {
    await consume();
    const observation = observe();
    const changed = rehashCommand({
      ...observation,
      input: { ...observation.input, reserveInputHash: 'a'.repeat(64) },
    } as any);
    expect(await consume(changed)).toMatchObject({ outcome: 'FAILED', result: { noEffect: null } });
    expect(
      await db.inventoryReserveNoEffectClosure.count({ where: { scope: { checkoutId } } }),
    ).toBe(0);
    expect(
      (
        await db.inventoryReserveScope.findUniqueOrThrow({
          where: { checkoutId_checkoutVersion: { checkoutId, checkoutVersion: 1 } },
        })
      ).revision,
    ).toBe(1);
  });
  it('keeps scope and no-effect authority attached through restrictive foreign keys', async () => {
    const closing = close();
    await consume(closing);
    const row = await db.inventoryReserveScope.findUniqueOrThrow({
      where: { checkoutId_checkoutVersion: { checkoutId, checkoutVersion: 1 } },
    });
    await expect(db.inventoryReserveScope.delete({ where: { id: row.id } })).rejects.toMatchObject({
      code: 'P2003',
    });
    await prisma.inventoryResultOutbox.deleteMany({ where: { operationId: closing.operationId } });
    await prisma.inventoryInboxEvent.deleteMany({ where: { operationId: closing.operationId } });
    await expect(
      prisma.inventoryCommand.delete({ where: { operationId: closing.operationId } }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await consume();
    expect(await prisma.stockReservation.count({ where: { itemId } })).toBe(0);
  });
  it('retains protected scope identity across delayed seller subsets, mixed observations and historical replay', async () => {
    if (original.command !== 'INVENTORY_RESERVE') throw new Error('fixture');
    original = rehashCommand({
      ...original,
      input: {
        ...original.input,
        lines: [original.input.lines[0], { ...original.input.lines[0], lineId: 'second' }],
      },
    });
    const held = await consume();
    if (held.outcome !== 'SUCCEEDED' || !('lines' in held.result)) throw new Error('fixture');
    const heldResult = held.result;
    const lines = heldResult.lines.map(({ reservationId, lineId, revision }) => ({
      reservationId,
      lineId,
      revision,
    }));
    const partial = request('INVENTORY_PROTECT', {
      checkoutId,
      version: 1,
      paymentScopeId: 'payment-scope',
      fence: 1,
      lines: [lines[0]],
    });
    expect(await consume(partial)).toMatchObject({ outcome: 'FAILED', result: { noEffect: null } });
    const protectionCommand = request('INVENTORY_PROTECT', {
      checkoutId,
      version: 1,
      paymentScopeId: 'payment-scope',
      fence: 1,
      lines,
    });
    const protectedResult = await consume(protectionCommand);
    if (protectedResult.outcome !== 'SUCCEEDED' || !('lines' in protectedResult.result))
      throw new Error('fixture');
    const protection = protectedResult.result;
    expect(protection.scope.revision).toBe(2);
    const commit = (index: number, scope = protection.scope) =>
      commandEnvelope('INVENTORY_COMMIT', {
        scope,
        checkoutId,
        version: 1,
        paymentScopeId: 'payment-scope',
        fence: 1,
        paymentId: 'payment',
        purchaseId: 'purchase',
        commerceSellerOrderId: `seller-order-${index}`,
        lines: [
          {
            reservationId: protection.lines[index].reservationId,
            lineId: protection.lines[index].lineId,
            revision: protection.lines[index].revision,
          },
        ],
      });
    expect(await consumeInventoryCommand(commit(0, heldResult.scope), 'fulfillment')).toMatchObject(
      { outcome: 'FAILED', result: { noEffect: null } },
    );
    const firstCommand = commit(0);
    const first = await consumeInventoryCommand(firstCommand, 'fulfillment');
    expect(first).toMatchObject({
      result: { scope: { revision: 3 }, lines: [{ state: 'COMMITTED' }] },
    });
    const mixedRequest = observe();
    const mixed = await consume(mixedRequest);
    expect(mixed).toMatchObject({
      result: {
        reservation: {
          scope: { revision: 3 },
          lines: [{ state: 'COMMITTED' }, { state: 'PAYMENT_LOCKED' }],
        },
      },
    });
    expect(await consumeInventoryCommand(commit(1), 'fulfillment')).toMatchObject({
      result: { scope: { revision: 4 } },
    });
    expect(await consumeInventoryCommand(firstCommand, 'fulfillment')).toEqual(first);
    expect(await consume(protectionCommand)).toEqual(protectedResult);
    expect(await consume(mixedRequest)).toEqual(mixed);
    expect(await consume(observe())).toMatchObject({
      result: {
        reservation: {
          scope: { revision: 4 },
          lines: [{ state: 'COMMITTED' }, { state: 'COMMITTED' }],
        },
      },
    });
    expect(await prisma.movement.count({ where: { itemId, reason: 'SOLD' } })).toBe(2);
    const record = await prisma.stockReservation.findFirstOrThrow({ where: { itemId } });
    await expect(
      prisma.stockReservation.update({ where: { id: record.id }, data: { checkoutVersion: 2 } }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });
});
