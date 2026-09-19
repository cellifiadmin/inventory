require('../helpers/purchaseTestEnvironment.cjs');

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from '@jest/globals';
import prisma from '@/lib/prismaInventory';
import { applyReturnRestock } from '@/inventory/services/returnRestockService';

describe('returned stock disposition', () => {
  const itemIds: number[] = [];
  const operationIds: string[] = [];

  afterEach(async () => {
    const lines = await prisma.returnRestockLine.findMany({ where: { operationId: { in: operationIds } } });
    await prisma.returnRestockLine.deleteMany({ where: { operationId: { in: operationIds } } });
    await prisma.returnRestockOperation.deleteMany({ where: { operationId: { in: operationIds } } });
    await prisma.movement.deleteMany({ where: { id: { in: lines.map((line) => line.movementId) } } });
    await prisma.item.deleteMany({ where: { id: { in: itemIds } } });
    itemIds.length = 0; operationIds.length = 0;
  });
  afterAll(() => prisma.$disconnect());

  it('applies inspected stock once under concurrent command replay', async () => {
    const suffix = randomUUID();
    const item = await prisma.item.create({ data: { kind: 'STOCK', itemCode: `phone-${suffix}`,
      sellerIdentifier: `seller-${suffix}` } });
    itemIds.push(item.id);
    const input = { operationId: `return:${suffix}:restock:v1`, returnId: `return-${suffix}`,
      sellerOrderId: `order-${suffix}`, sellerAccountId: item.sellerIdentifier,
      evidenceHash: 'a'.repeat(64), lines: [{ sourceInvId: item.itemCode,
        commercePurchaseLineId: `line-${suffix}`, quantity: 1 }] };
    operationIds.push(input.operationId);
    const [first, replay] = await Promise.all([applyReturnRestock(input), applyReturnRestock(input)]);
    expect(first).toEqual(replay);
    expect(await prisma.returnRestockOperation.count({ where: { operationId: input.operationId } })).toBe(1);
    expect(await prisma.movement.findMany({ where: { itemId: item.id } })).toEqual([
      expect.objectContaining({ direction: 'IN', reason: 'RETURNED', quantity: 1 }),
    ]);
  });
});
