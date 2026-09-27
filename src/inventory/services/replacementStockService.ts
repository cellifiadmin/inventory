import { z } from 'zod';
import type { Prisma } from '@/lib/prismaInventoryTypes';
import { captureSaleIdentity } from '@/inventory/services/saleIdentityService';
import { lockStockItems, stockBalance, type InventoryStockTransaction } from '@/inventory/services/stockReservationShared';
import { workflowInputHash } from '@/inventory/services/workflows/workflowIdentity';

const id = z.string().trim().min(1).max(191);
export const replacementReserveInputSchema = z.object({ shipmentId: id, entitlementId: id,
  sellerOrderId: id, sellerAccountId: id, purchaseId: id, commerceSellerOrderId: id,
  commercePurchaseLineId: id, sourceInvId: id, quantity: z.number().int().positive().safe() }).strict();
export const replacementReserveResultSchema = z.object({ shipmentId: id, entitlementId: id,
  sellerOrderId: id, itemId: z.number().int().positive(), heldMovementId: z.number().int().positive(),
  quantity: z.number().int().positive() }).strict();
export const replacementTransitionInputSchema = replacementReserveInputSchema.extend({
  holdOperationId: z.string().min(1).max(160), itemId: z.number().int().positive(),
  heldMovementId: z.number().int().positive() }).strict();
export const replacementTransitionResultSchema = z.object({ shipmentId: id, entitlementId: id,
  sellerOrderId: id, itemId: z.number().int().positive(), heldMovementId: z.number().int().positive(),
  releasedMovementId: z.number().int().positive(), soldMovementId: z.number().int().positive().nullable(),
  quantity: z.number().int().positive(), phase: z.enum(['COMMIT', 'RELEASE']) }).strict();

export const reserveReplacementStock = async (rawInput: unknown, tx: InventoryStockTransaction) => {
  const input = z.object({ operationId: z.string().min(1).max(160) })
    .merge(replacementReserveInputSchema).parse(rawInput);
  const inputHash = workflowInputHash(input);
  const existing = await tx.replacementStockHold.findUnique({ where: { operationId: input.operationId } });
  if (existing) {
    if (existing.inputHash !== inputHash) throw new Error('REPLACEMENT_STOCK_IDEMPOTENCY_CONFLICT');
    return replacementReserveResultSchema.parse({ shipmentId: existing.shipmentId,
      entitlementId: existing.entitlementId, sellerOrderId: existing.sellerOrderId,
      itemId: existing.itemId, heldMovementId: existing.heldMovementId, quantity: existing.quantity });
  }
  const item = await tx.item.findUnique({ where: { sellerIdentifier_itemCode: {
    sellerIdentifier: input.sellerAccountId, itemCode: input.sourceInvId } },
    select: { id: true, deletedAt: true, status: true } });
  if (!item || item.deletedAt || item.status !== 'ACTIVE') throw new Error('REPLACEMENT_STOCK_ITEM_NOT_FOUND');
  await lockStockItems(tx, [item.id]);
  const sales = await tx.stockReservation.findMany({ where: { state: 'COMMITTED', itemId: item.id,
    lineId: input.commercePurchaseLineId, purchaseId: input.purchaseId,
    commerceSellerOrderId: input.commerceSellerOrderId,
    scopeLine: { accountId: input.sellerAccountId, sourceInvId: input.sourceInvId } },
    include: { soldMovement: true }, take: 2 });
  if (sales.length !== 1 || !sales[0].soldMovement || sales[0].soldMovement.direction !== 'OUT' ||
    sales[0].soldMovement.reason !== 'SOLD' || sales[0].soldMovement.itemId !== item.id)
    throw new Error('REPLACEMENT_STOCK_SALE_NOT_FOUND');
  if ((await stockBalance(tx, item.id)) < input.quantity) throw new Error('REPLACEMENT_STOCK_UNAVAILABLE');
  const saleIdentity = await captureSaleIdentity(tx, item.id, input.quantity);
  const heldMovement = await tx.movement.create({ data: { itemId: item.id,
    quantity: input.quantity, direction: 'OUT', reason: 'RESERVED',
    metadata: { replacementShipmentId: input.shipmentId, entitlementId: input.entitlementId,
      sellerOrderId: input.sellerOrderId, purchaseId: input.purchaseId,
      commerceSellerOrderId: input.commerceSellerOrderId,
      commercePurchaseLineId: input.commercePurchaseLineId, originalSaleMovementId: sales[0].soldMovement.id,
      saleIdentity } } });
  await tx.replacementStockHold.create({ data: { operationId: input.operationId,
    shipmentId: input.shipmentId, entitlementId: input.entitlementId,
    sellerOrderId: input.sellerOrderId, sellerAccountId: input.sellerAccountId,
    purchaseId: input.purchaseId, commerceSellerOrderId: input.commerceSellerOrderId,
    commercePurchaseLineId: input.commercePurchaseLineId, itemId: item.id, quantity: input.quantity,
    inputHash, saleIdentity: saleIdentity as Prisma.InputJsonValue, heldMovementId: heldMovement.id } });
  return replacementReserveResultSchema.parse({ shipmentId: input.shipmentId,
    entitlementId: input.entitlementId, sellerOrderId: input.sellerOrderId,
    itemId: item.id, heldMovementId: heldMovement.id, quantity: input.quantity });
};

export const transitionReplacementStock = async (rawInput: unknown,
  phase: 'COMMIT' | 'RELEASE', tx: InventoryStockTransaction) => {
  const input = replacementTransitionInputSchema.parse(rawInput);
  const first = await tx.replacementStockHold.findUnique({ where: { operationId: input.holdOperationId } });
  if (!first) throw new Error('REPLACEMENT_STOCK_HOLD_NOT_FOUND');
  await lockStockItems(tx, [first.itemId]);
  const hold = await tx.replacementStockHold.findUniqueOrThrow({ where: { operationId: input.holdOperationId } });
  if (hold.state !== 'HELD') throw new Error('REPLACEMENT_STOCK_ALREADY_RESOLVED');
  if (hold.shipmentId !== input.shipmentId || hold.entitlementId !== input.entitlementId ||
    hold.sellerOrderId !== input.sellerOrderId || hold.sellerAccountId !== input.sellerAccountId ||
    hold.purchaseId !== input.purchaseId || hold.commerceSellerOrderId !== input.commerceSellerOrderId ||
    hold.commercePurchaseLineId !== input.commercePurchaseLineId || hold.itemId !== input.itemId ||
    hold.heldMovementId !== input.heldMovementId || hold.quantity !== input.quantity)
    throw new Error('REPLACEMENT_STOCK_HOLD_SCOPE_CONFLICT');
  const item = await tx.item.findUniqueOrThrow({ where: { id: hold.itemId } });
  if (item.sellerIdentifier !== input.sellerAccountId || item.itemCode !== input.sourceInvId)
    throw new Error('REPLACEMENT_STOCK_HOLD_SCOPE_CONFLICT');
  const released = await tx.movement.create({ data: { itemId: hold.itemId,
    quantity: hold.quantity, direction: 'IN', reason: 'RELEASED',
    metadata: { replacementShipmentId: hold.shipmentId, entitlementId: hold.entitlementId,
      heldMovementId: hold.heldMovementId, resolution: phase } } });
  const sold = phase === 'COMMIT' ? await tx.movement.create({ data: { itemId: hold.itemId,
    quantity: hold.quantity, direction: 'OUT', reason: 'REPLACEMENT',
    metadata: { replacementShipmentId: hold.shipmentId, entitlementId: hold.entitlementId,
      sellerOrderId: hold.sellerOrderId, purchaseId: hold.purchaseId,
      commerceSellerOrderId: hold.commerceSellerOrderId,
      commercePurchaseLineId: hold.commercePurchaseLineId,
      heldMovementId: hold.heldMovementId, saleIdentity: hold.saleIdentity as Prisma.InputJsonValue } } }) : null;
  await tx.replacementStockHold.update({ where: { id: hold.id }, data: { state: phase === 'COMMIT' ? 'COMMITTED' : 'RELEASED',
    releasedMovementId: released.id, soldMovementId: sold?.id ?? null } });
  return replacementTransitionResultSchema.parse({ shipmentId: hold.shipmentId,
    entitlementId: hold.entitlementId, sellerOrderId: hold.sellerOrderId,
    itemId: hold.itemId, heldMovementId: hold.heldMovementId,
    releasedMovementId: released.id, soldMovementId: sold?.id ?? null,
    quantity: hold.quantity, phase });
};
