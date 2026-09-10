require('../helpers/purchaseTestEnvironment.cjs');

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import prisma from '@/lib/prismaInventory';
import { reserveStock } from '@/inventory/services/stockReservationService';

describe('reservation quantity invariants against PostgreSQL', () => {
  let itemId: number;
  let itemCode: string;
  const seller = 'workflow-test-seller';
  beforeEach(async () => {
    itemCode = `workflow-test-${randomUUID()}`;
    const item = await prisma.item.create({ data: { kind: 'STOCK', itemCode, sellerIdentifier: seller } });
    itemId = item.id;
    await prisma.movement.create({ data: { itemId, direction: 'IN', reason: 'ADJUSTMENT', quantity: 1 } });
  });
  afterEach(async () => {
    if (itemId) {
      await prisma.movement.deleteMany({ where: { itemId } });
      await prisma.item.delete({ where: { id: itemId } });
    }
  });
  afterAll(async () => { await prisma.$disconnect(); });
  const balance = async () => (await prisma.movement.findMany({ where: { itemId } }))
    .reduce((sum, movement) => sum + (movement.direction === 'IN' ? movement.quantity : -movement.quantity), 0);

  it('rejects two lines whose combined quantity exceeds the same item stock', async () => {
    await expect(reserveStock({ checkoutId: itemCode, version: 4, lines: [
      { lineId: 'a', accountId: seller, sourceInvId: itemCode, quantity: 1 },
      { lineId: 'b', accountId: seller, sourceInvId: itemCode, quantity: 1 },
    ] })).rejects.toThrow(`Insufficient inventory available for ${itemCode}`);
    expect(await balance()).toBe(1);
  });

  it('allows at most one of two concurrent checkouts to reserve the last unit', async () => {
    const attempts = await Promise.allSettled(['a', 'b'].map((suffix) => reserveStock({
      checkoutId: `${itemCode}-${suffix}`, version: 1,
      lines: [{ lineId: suffix, accountId: seller, sourceInvId: itemCode, quantity: 1 }],
    })));
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(await balance()).toBe(0);
  });
  it('rejects repeated line identities before reserving any stock', async () => {
    await expect(reserveStock({ checkoutId: itemCode, version: 1, lines: [
      { lineId: 'same', accountId: seller, sourceInvId: itemCode, quantity: 1 },
      { lineId: 'same', accountId: seller, sourceInvId: itemCode, quantity: 1 },
    ] })).rejects.toThrow('Duplicate stock line identity');
    expect(await balance()).toBe(1);
  });
  it('rejects a changed quantity when replaying a reserved line', async () => {
    const input = { checkoutId: itemCode, version: 1,
      lines: [{ lineId: 'line', accountId: seller, sourceInvId: itemCode, quantity: 1 }] };
    await reserveStock(input);
    await expect(reserveStock({ ...input, lines: [{ ...input.lines[0], quantity: 2 }] }))
      .rejects.toThrow('Reservation input changed for line');
    expect(await balance()).toBe(0);
  });
  it('serializes concurrent replay of the same checkout and line', async () => {
    const input = { checkoutId: itemCode, version: 1,
      lines: [{ lineId: 'line', accountId: seller, sourceInvId: itemCode, quantity: 1 }] };
    const results = await Promise.all([1, 2].map(() => reserveStock(input)));
    expect(results[0]).toEqual(results[1]);
    expect(await prisma.movement.count({ where: { itemId, reason: 'RESERVED' } })).toBe(1);
    expect(await balance()).toBe(0);
  });
  it('accepts multiple lines for one item when their combined quantity is available', async () => {
    await prisma.movement.create({ data: { itemId, direction: 'IN', reason: 'ADJUSTMENT', quantity: 1 } });
    await reserveStock({ checkoutId: itemCode, version: 1, lines: [
      { lineId: 'a', accountId: seller, sourceInvId: itemCode, quantity: 1 },
      { lineId: 'b', accountId: seller, sourceInvId: itemCode, quantity: 1 },
    ] });
    expect(await balance()).toBe(0);
  });

  it.each([{}, { expiresAt: '2000-01-01T00:00:00.000Z' }])('does not invent expiry when replaying an invalid or expired hold %p', async expiry => {
    const input = { checkoutId: itemCode, version: 1,
      lines: [{ lineId: 'line', accountId: seller, sourceInvId: itemCode, quantity: 1 }] };
    await reserveStock(input);
    await prisma.movement.updateMany({ where: { itemId, reason: 'RESERVED' }, data: {
      metadata: { checkoutId: itemCode, version: 1, lineId: 'line', ...expiry },
    } });
    await expect(reserveStock(input)).rejects.toThrow('Reservation expiry invalid or elapsed for line');
    expect(await balance()).toBe(0);
  });

});
