import { validateReturnedIdentity } from '@/inventory/services/saleIdentityService';
import { z } from 'zod';
import { MovementDirection, MovementReason, type Prisma } from '@/lib/prismaInventoryTypes';
import { workflowInputHash } from '@/inventory/services/workflows/workflowIdentity';
import { lockStockItems, withStockTransaction, type InventoryStockTransaction } from '@/inventory/services/stockReservationShared';

const id = z.string().trim().min(1).max(191);
export const returnRestockInputObjectSchema = z.object({
  operationId: z.string().trim().min(1).max(160),
  returnId: id,
  sellerOrderId: id,
  sellerAccountId: id,
  purchaseId: id,
  commerceSellerOrderId: id,
  identifiers: z.array(id).max(100),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
  lines: z.array(z.object({ sourceInvId: id, commercePurchaseLineId: id,
    quantity: z.number().int().positive().safe() }).strict()).min(1).max(100),
}).strict();
const uniqueLines = (input: { lines: Array<{ commercePurchaseLineId: string }> }, ctx: z.RefinementCtx) => {
  if (new Set(input.lines.map((line) => line.commercePurchaseLineId)).size !== input.lines.length)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate returned purchase line' });
};
export const returnRestockInputSchema = returnRestockInputObjectSchema.superRefine(uniqueLines);
export const returnRestockCommandInputSchema = returnRestockInputObjectSchema.omit({ operationId: true }).superRefine(uniqueLines);
export const returnRestockResultSchema = z.object({ returnId: id, sellerOrderId: id,
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
  lines: z.array(z.object({ commercePurchaseLineId: id, itemId: z.number().int().positive(),
    movementId: z.number().int().positive(), quantity: z.number().int().positive() }).strict()).min(1),
}).strict();

export const parseReturnRestockInput = (input: unknown) => returnRestockInputSchema.parse(input);

export const applyReturnRestock = (rawInput: unknown, transaction?: InventoryStockTransaction) => {
  const input = parseReturnRestockInput(rawInput);
  const inputHash = workflowInputHash(input);
  return withStockTransaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`return-restock:${input.operationId}`}, 0))`;
    const existing = await tx.returnRestockOperation.findUnique({ where: { operationId: input.operationId } });
    if (existing) {
      if (existing.inputHash !== inputHash) throw new Error('RETURN_RESTOCK_IDEMPOTENCY_CONFLICT');
      return returnRestockResultSchema.parse(existing.result);
    }
    const resolved = [];
    for (const line of input.lines) {
      const item = await tx.item.findUnique({ where: { sellerIdentifier_itemCode: {
        sellerIdentifier: input.sellerAccountId, itemCode: line.sourceInvId } }, select: { id: true, deletedAt: true } });
      if (!item || item.deletedAt) throw new Error('RETURN_RESTOCK_ITEM_NOT_FOUND');
      resolved.push({ line, item });
    }
    await lockStockItems(tx, resolved.map((row) => row.item.id));
    const sales = [];
    for (const row of resolved) {
      const matches = await tx.stockReservation.findMany({ where: {
        state: 'COMMITTED', itemId: row.item.id, lineId: row.line.commercePurchaseLineId,
        purchaseId: input.purchaseId, commerceSellerOrderId: input.commerceSellerOrderId,
        scopeLine: { accountId: input.sellerAccountId, sourceInvId: row.line.sourceInvId },
      }, include: { soldMovement: true }, take: 2 });
      const sale = matches[0];
      if (matches.length !== 1 || !sale.soldMovement || sale.soldMovement.direction !== 'OUT' ||
        sale.soldMovement.reason !== 'SOLD' || sale.soldMovement.itemId !== row.item.id)
        throw new Error('RETURN_RESTOCK_SALE_NOT_FOUND');
      const prior = await tx.movement.aggregate({ where: { itemId: row.item.id, direction: 'IN', reason: 'RETURNED',
        metadata: { path: ['originalSaleMovementId'], equals: sale.soldMovement.id } }, _sum: { quantity: true } });
      if (row.line.quantity > sale.soldMovement.quantity - (prior._sum.quantity ?? 0))
        throw new Error('RETURN_RESTOCK_SOLD_QUANTITY_EXCEEDED');
      sales.push({ ...row, sale, originalSale: sale.soldMovement });
    }
    validateReturnedIdentity(sales.map(row => (row.originalSale.metadata as { saleIdentity?: unknown } | null)?.saleIdentity), input.identifiers);
    const lines = [];
    for (const row of sales) {
      const movement = await tx.movement.create({ data: { itemId: row.item.id,
        quantity: row.line.quantity, direction: MovementDirection.IN, reason: MovementReason.RETURNED,
        metadata: { returnId: input.returnId, sellerOrderId: input.sellerOrderId,
          originalSaleMovementId: row.originalSale.id, reservationId: row.sale.id,
          purchaseId: input.purchaseId, commerceSellerOrderId: input.commerceSellerOrderId,
          evidenceHash: input.evidenceHash, commercePurchaseLineId: row.line.commercePurchaseLineId } } });
      lines.push({ commercePurchaseLineId: row.line.commercePurchaseLineId, itemId: row.item.id,
        movementId: movement.id, quantity: row.line.quantity });
    }
    const result = returnRestockResultSchema.parse({ returnId: input.returnId,
      sellerOrderId: input.sellerOrderId, evidenceHash: input.evidenceHash, lines });
    await tx.returnRestockOperation.create({ data: { operationId: input.operationId,
      returnId: input.returnId, sellerOrderId: input.sellerOrderId,
      sellerAccountId: input.sellerAccountId, evidenceHash: input.evidenceHash,
      inputHash, input: input as Prisma.InputJsonValue, result: result as Prisma.InputJsonValue,
      lines: { create: lines.map((line) => ({ itemId: line.itemId, movementId: line.movementId,
        commercePurchaseLineId: line.commercePurchaseLineId, quantity: line.quantity })) } } });
    return result;
  }, transaction);
};
