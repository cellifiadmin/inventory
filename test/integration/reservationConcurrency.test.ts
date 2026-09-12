require('../helpers/purchaseTestEnvironment.cjs');

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import prisma from '@/lib/prismaInventory';
import { SYNTHETIC_HOLD_DURATION_MS } from '../helpers/reservationFixtures';
import { databaseNow } from '@/inventory/services/stockReservationShared';
import { reserveStock, cleanupReservationScopeFixture } from '../helpers/reserveThroughOwner';

describe('reservation quantity invariants against PostgreSQL', () => {
  let itemId: number;
  let itemCode: string;
  let expiresAt: string;
  const seller = 'workflow-test-seller';
  beforeEach(async () => {
    expiresAt = new Date(
      (await databaseNow(prisma)).getTime() + SYNTHETIC_HOLD_DURATION_MS,
    ).toISOString();
    itemCode = `workflow-test-${randomUUID()}`;
    const item = await prisma.item.create({
      data: { kind: 'STOCK', itemCode, sellerIdentifier: seller },
    });
    itemId = item.id;
    await prisma.movement.create({
      data: { itemId, direction: 'IN', reason: 'ADJUSTMENT', quantity: 1 },
    });
  });
  afterEach(async () => {
    await cleanupReservationScopeFixture(itemCode);
    if (itemId) {
      await prisma.stockReservation.deleteMany({ where: { itemId } });
      await prisma.reservationOperation.deleteMany({
        where: { checkoutId: { startsWith: itemCode } },
      });
      await prisma.movement.deleteMany({ where: { itemId } });
      await prisma.item.delete({ where: { id: itemId } });
    }
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  const balance = async () =>
    (await prisma.movement.findMany({ where: { itemId } })).reduce(
      (sum, movement) =>
        sum + (movement.direction === 'IN' ? movement.quantity : -movement.quantity),
      0,
    );

  it('rejects elapsed incoming work without any reservation or reserved movement', async () => {
    const operationId = randomUUID();
    await expect(
      reserveStock({
        operationId,
        checkoutId: itemCode,
        version: 1,
        expiresAt: (await databaseNow(prisma)).toISOString(),
        lines: [{ lineId: 'line', accountId: seller, sourceInvId: itemCode, quantity: 1 }],
      }),
    ).rejects.toThrow('INVENTORY_RESERVATION_REJECTED');
    expect(await prisma.stockReservation.count({ where: { itemId } })).toBe(0);
    expect(await prisma.reservationOperation.findUnique({ where: { id: operationId } })).toBeNull();
    expect(await balance()).toBe(1);
  });
  it('pins exactly one caller expiry when different operations race for the same checkout version', async () => {
    const expiries = [expiresAt, new Date(new Date(expiresAt).getTime() + 1234).toISOString()];
    const results = await Promise.allSettled(
      expiries.map((expiry) =>
        reserveStock({
          operationId: randomUUID(),
          checkoutId: itemCode,
          version: 1,
          expiresAt: expiry,
          lines: [{ lineId: 'line', accountId: seller, sourceInvId: itemCode, quantity: 1 }],
        }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results.findIndex((result) => result.status === 'fulfilled');
    const loser = results[1 - winner];
    expect(loser).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'INVENTORY_RESERVATION_REJECTED' }),
    });
    const row = await prisma.stockReservation.findFirstOrThrow({ where: { itemId } });
    expect(row.expiresAt.toISOString()).toBe(expiries[winner]);
    expect(await prisma.movement.count({ where: { itemId, reason: 'RESERVED' } })).toBe(1);
    expect(await prisma.reservationOperation.count({ where: { checkoutId: itemCode } })).toBe(1);
  });
  it('rechecks the database clock after waiting for another writer stock lock', async () => {
    let signalLocked!: () => void, signalAttempt!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const attempted = new Promise<void>((resolve) => {
      signalAttempt = resolve;
    });
    let expiry = '';
    const blocker = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM items WHERE id=${itemId} FOR UPDATE`;
      // This short duration deliberately tests a boundary; it is not a runtime policy.
      expiry = new Date((await databaseNow(tx)).getTime() + 250).toISOString();
      signalLocked();
      await attempted;
      await tx.$executeRaw`SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM ${expiry}::timestamptz - clock_timestamp())) + 0.01)`;
    });
    await locked;
    const operationId = randomUUID();
    const reservation = prisma.$transaction(async (tx) => {
      const observed = new Proxy(tx, {
        get(target, key) {
          if (key !== '$queryRaw') return Reflect.get(target, key);
          return (parts: TemplateStringsArray, ...values: unknown[]) => {
            const pending = target.$queryRaw(parts, ...values);
            if (parts.join('').includes('FROM items')) signalAttempt();
            return pending;
          };
        },
      });
      return reserveStock(
        {
          operationId,
          checkoutId: itemCode,
          version: 1,
          expiresAt: expiry,
          lines: [{ lineId: 'line', accountId: seller, sourceInvId: itemCode, quantity: 1 }],
        },
        observed,
      );
    });
    const results = await Promise.allSettled([blocker, reservation]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'INVENTORY_RESERVATION_REJECTED' }),
    });
    expect(await prisma.stockReservation.count({ where: { itemId } })).toBe(0);
    expect(await prisma.reservationOperation.findUnique({ where: { id: operationId } })).toBeNull();
    expect(await balance()).toBe(1);
  });

  it('rolls back earlier line effects when the caller expiry passes during a multi-line reservation', async () => {
    await prisma.movement.create({
      data: { itemId, direction: 'IN', reason: 'ADJUSTMENT', quantity: 1 },
    });
    const operationId = randomUUID();
    const created: string[] = [];
    await expect(
      prisma.$transaction(async (tx) => {
        const expiry = new Date((await databaseNow(tx)).getTime() + 1000).toISOString();
        const observed = new Proxy(tx, {
          get(target, key) {
            if (key !== 'stockReservation') return Reflect.get(target, key);
            return new Proxy(target.stockReservation, {
              get(delegate, method) {
                if (method !== 'create') return Reflect.get(delegate, method);
                return async (...args: Parameters<typeof delegate.create>) => {
                  const row = await delegate.create(...args);
                  created.push(row.id);
                  await tx.$executeRaw`SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM ${expiry}::timestamptz - clock_timestamp())) + 0.01)`;
                  return row;
                };
              },
            });
          },
        });
        return reserveStock(
          {
            operationId,
            checkoutId: itemCode,
            version: 1,
            expiresAt: expiry,
            lines: ['first', 'second'].map((lineId) => ({
              lineId,
              accountId: seller,
              sourceInvId: itemCode,
              quantity: 1,
            })),
          },
          observed,
        );
      }),
    ).rejects.toThrow('INVENTORY_RESERVATION_REJECTED');
    expect(created).toHaveLength(1);
    expect(await prisma.stockReservation.count({ where: { itemId } })).toBe(0);
    expect(await prisma.movement.count({ where: { itemId, reason: 'RESERVED' } })).toBe(0);
    expect(await prisma.reservationOperation.findUnique({ where: { id: operationId } })).toBeNull();
    expect(await balance()).toBe(2);
  });

  it('rejects two lines whose combined quantity exceeds the same item stock', async () => {
    await expect(
      reserveStock({
        operationId: randomUUID(),
        checkoutId: itemCode,
        version: 4,
        expiresAt,
        lines: [
          { lineId: 'a', accountId: seller, sourceInvId: itemCode, quantity: 1 },
          { lineId: 'b', accountId: seller, sourceInvId: itemCode, quantity: 1 },
        ],
      }),
    ).rejects.toThrow('INVENTORY_RESERVATION_REJECTED');
    expect(await balance()).toBe(1);
  });

  it('allows at most one of two concurrent checkouts to reserve the last unit', async () => {
    const attempts = await Promise.allSettled(
      ['a', 'b'].map((suffix) =>
        reserveStock({
          operationId: randomUUID(),
          checkoutId: `${itemCode}-${suffix}`,
          version: 1,
          expiresAt,
          lines: [{ lineId: suffix, accountId: seller, sourceInvId: itemCode, quantity: 1 }],
        }),
      ),
    );
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(await balance()).toBe(0);
  });
  it('rejects repeated line identities before reserving any stock', async () => {
    await expect(
      reserveStock({
        operationId: randomUUID(),
        checkoutId: itemCode,
        version: 1,
        expiresAt,
        lines: [
          { lineId: 'same', accountId: seller, sourceInvId: itemCode, quantity: 1 },
          { lineId: 'same', accountId: seller, sourceInvId: itemCode, quantity: 1 },
        ],
      }),
    ).rejects.toThrow('Duplicate stock line identity');
    expect(await balance()).toBe(1);
  });
  it('rejects a changed quantity when replaying a reserved line', async () => {
    const input = {
      operationId: randomUUID(),
      checkoutId: itemCode,
      version: 1,
      expiresAt,
      lines: [{ lineId: 'line', accountId: seller, sourceInvId: itemCode, quantity: 1 }],
    };
    await reserveStock(input);
    await expect(
      reserveStock({ ...input, lines: [{ ...input.lines[0], quantity: 2 }] }),
    ).rejects.toThrow('INVENTORY_COMMAND_ENVELOPE_CONFLICT');
    expect(await balance()).toBe(0);
  });
  it('serializes concurrent replay of the same checkout and line', async () => {
    const input = {
      operationId: randomUUID(),
      checkoutId: itemCode,
      version: 1,
      expiresAt,
      lines: [{ lineId: 'line', accountId: seller, sourceInvId: itemCode, quantity: 1 }],
    };
    const results = await Promise.all([1, 2].map(() => reserveStock(input)));
    expect(results[0]).toEqual(results[1]);
    expect(await prisma.movement.count({ where: { itemId, reason: 'RESERVED' } })).toBe(1);
    expect(await balance()).toBe(0);
  });
  it('accepts multiple lines for one item when their combined quantity is available', async () => {
    await prisma.movement.create({
      data: { itemId, direction: 'IN', reason: 'ADJUSTMENT', quantity: 1 },
    });
    await reserveStock({
      operationId: randomUUID(),
      checkoutId: itemCode,
      version: 1,
      expiresAt,
      lines: [
        { lineId: 'a', accountId: seller, sourceInvId: itemCode, quantity: 1 },
        { lineId: 'b', accountId: seller, sourceInvId: itemCode, quantity: 1 },
      ],
    });
    expect(await balance()).toBe(0);
  });

  it('rejects a new reserve operation for an expired typed hold without extending it', async () => {
    const input = {
      operationId: randomUUID(),
      checkoutId: itemCode,
      version: 1,
      expiresAt,
      lines: [{ lineId: 'line', accountId: seller, sourceInvId: itemCode, quantity: 1 }],
    };
    const original = await reserveStock(input);
    await prisma.stockReservation.update({
      where: { id: original.lines[0].reservationId },
      data: { expiresAt: new Date('2000-01-01') },
    });
    await expect(reserveStock({ ...input, operationId: randomUUID() })).rejects.toThrow(
      'INVENTORY_RESERVATION_REJECTED',
    );
    expect(await reserveStock(input)).toEqual(original);
    expect(await balance()).toBe(0);
  });
});
