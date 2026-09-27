require('../helpers/purchaseTestEnvironment.cjs');

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from '@jest/globals';
import prisma from '@/lib/prismaInventory';
import { reserveStock, cleanupReservationScopeFixture } from '../helpers/reserveThroughOwner';
import { protectReservations } from '@/inventory/services/reservationProtectionService';
import { commitStock } from '@/inventory/services/stockCommitService';
import { applyReturnRestock } from '@/inventory/services/returnRestockService';

describe('returned stock disposition', () => {
  const itemIds: number[] = [];
  const operationIds: string[] = [];
  const checkoutIds: string[] = [];
  const instanceIds: number[] = [];

  afterEach(async () => {
    const lines = await prisma.returnRestockLine.findMany({ where: { operationId: { in: operationIds } } });
    await prisma.returnRestockLine.deleteMany({ where: { operationId: { in: operationIds } } });
    await prisma.returnRestockOperation.deleteMany({ where: { operationId: { in: operationIds } } });
    await prisma.movement.deleteMany({ where: { id: { in: lines.map((line) => line.movementId) } } });
    for (const checkout of checkoutIds) await cleanupReservationScopeFixture(checkout);
    await prisma.component.deleteMany({ where: { itemId: { in: itemIds } } });
    await prisma.instance.deleteMany({ where: { id: { in: instanceIds } } });
    await prisma.movement.deleteMany({ where: { itemId: { in: itemIds } } });
    await prisma.item.deleteMany({ where: { id: { in: itemIds } } });
    itemIds.length = 0; operationIds.length = 0; checkoutIds.length = 0; instanceIds.length = 0;
  });
  afterAll(() => prisma.$disconnect());

  const fixture = async (quantity = 1, serialized = false) => {
    const suffix = randomUUID();
    const item = await prisma.item.create({ data: { kind: 'STOCK', itemCode: `phone-${suffix}`, sellerIdentifier: `seller-${suffix}` } });
    itemIds.push(item.id); checkoutIds.push(item.itemCode);
    const identifiers: string[] = [];
    if (serialized) {
      const instance = await prisma.instance.create({ data: { identifier: `serial-${suffix}`, sku: 'fixture-phone', productType: 'PHONE' } });
      instanceIds.push(instance.id); identifiers.push(instance.identifier);
      await prisma.component.create({ data: { itemId: item.id, childType: 'INSTANCE', instanceId: instance.id } });
    }
    await prisma.movement.create({ data: { itemId: item.id, direction: 'IN', reason: 'STOCKED', quantity } });
    const held = await reserveStock({ operationId: randomUUID(), checkoutId: item.itemCode, version: 1,
      expiresAt: new Date(Date.now() + 60000).toISOString(), lines: [{ lineId: `line-${suffix}`, accountId: item.sellerIdentifier, sourceInvId: item.itemCode, quantity }] });
    const lineage = (lines: typeof held.lines) => lines.map(({ reservationId, lineId, revision }) => ({ reservationId, lineId, revision }));
    const locked = await protectReservations({ operationId: randomUUID(), checkoutId: item.itemCode, version: 1,
      paymentScopeId: `payment-scope-${suffix}`, fence: 1, lines: lineage(held.lines) });
    const purchaseId = `purchase-${suffix}`, commerceSellerOrderId = `commercial-${suffix}`;
    await commitStock({ scope: locked.scope, operationId: randomUUID(), checkoutId: item.itemCode, version: 1,
      paymentScopeId: `payment-scope-${suffix}`, fence: 1, paymentId: `payment-${suffix}`, purchaseId, commerceSellerOrderId, lines: lineage(locked.lines) });
    const input = { operationId: `return:${suffix}:restock:v1`, returnId: `return-${suffix}`,
      sellerOrderId: `order-${suffix}`, sellerAccountId: item.sellerIdentifier, purchaseId, commerceSellerOrderId, identifiers,
      evidenceHash: 'a'.repeat(64), lines: [{ sourceInvId: item.itemCode, commercePurchaseLineId: `line-${suffix}`, quantity: 1 }] };
    operationIds.push(input.operationId);
    return { item, input };
  };
  it('applies inspected stock once under concurrent command replay with original-sale provenance', async () => {
    const { item, input } = await fixture();
    const [first, replay] = await Promise.all([applyReturnRestock(input), applyReturnRestock(input)]);
    expect(first).toEqual(replay);
    expect(await prisma.returnRestockOperation.count({ where: { operationId: input.operationId } })).toBe(1);
    const returned = await prisma.movement.findMany({ where: { itemId: item.id, reason: 'RETURNED' } });
    expect(returned).toEqual([expect.objectContaining({ direction: 'IN', quantity: 1, metadata: expect.objectContaining({ purchaseId: input.purchaseId, originalSaleMovementId: expect.any(Number) }) })]);
    await expect(applyReturnRestock({ ...input, operationId: 'extra-operation', returnId: 'extra-return' })).rejects.toThrow('RETURN_RESTOCK_SOLD_QUANTITY_EXCEEDED');
  });
  it('rejects another purchase and mismatched physical identity even if current item identity is edited', async () => {
    const { input } = await fixture(1, true);
    await expect(applyReturnRestock({ ...input, purchaseId: 'foreign-purchase' })).rejects.toThrow('RETURN_RESTOCK_SALE_NOT_FOUND');
    await prisma.instance.update({ where: { id: instanceIds[0] }, data: { identifier: 'edited-after-sale' } });
    await expect(applyReturnRestock({ ...input, identifiers: ['edited-after-sale'] })).rejects.toThrow('RETURN_RESTOCK_IDENTITY_MISMATCH');
    await expect(applyReturnRestock(input)).resolves.toMatchObject({ returnId: input.returnId });
  });
  it('serializes competing return cases against the total sold quantity', async () => {
    const { item, input } = await fixture();
    const second = { ...input, operationId: input.operationId + ':other', returnId: input.returnId + ':other' };
    operationIds.push(second.operationId);
    const results = await Promise.allSettled([applyReturnRestock(input), applyReturnRestock(second)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.movement.count({ where: { itemId: item.id, reason: 'RETURNED' } })).toBe(1);
  });
});
