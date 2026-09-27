import { z } from 'zod';
import type { InventoryStockTransaction } from '@/inventory/services/stockReservationShared';
import { loadRestorableSales } from '@/inventory/services/stockRestorationScope';
const id = z.string().trim().min(1).max(191);
export const cancellationRestorationInputSchema = z.object({ cancellationId: id, sellerOrderId: id,
  sellerAccountId: id, purchaseId: id, commerceSellerOrderId: id,
  lines: z.array(z.object({ sourceInvId: id, commercePurchaseLineId: id, quantity: z.number().int().positive().safe() }).strict()).min(1).max(100),
}).strict().superRefine((input, ctx) => {
  if (new Set(input.lines.map(line => line.commercePurchaseLineId)).size !== input.lines.length)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate cancellation line' });
});
export const cancellationRestorationResultSchema = z.object({ cancellationId: id, sellerOrderId: id,
  lines: z.array(z.object({ commercePurchaseLineId: id, itemId: z.number().int().positive(),
    movementId: z.number().int().positive(), quantity: z.number().int().positive() }).strict()).min(1).max(100),
}).strict();
export const applyCancellationRestoration = async (rawInput: unknown, tx: InventoryStockTransaction) => {
  const input = cancellationRestorationInputSchema.parse(rawInput);
  const sales = await loadRestorableSales(tx, input);
  const lines = [];
  for (const row of sales) {
    const movement = await tx.movement.create({ data: { itemId: row.item.id, quantity: row.line.quantity,
      direction: 'IN', reason: 'RELEASED', metadata: { restorationKind: 'CANCELLATION', cancellationId: input.cancellationId,
        sellerOrderId: input.sellerOrderId, purchaseId: input.purchaseId, commerceSellerOrderId: input.commerceSellerOrderId,
        commercePurchaseLineId: row.line.commercePurchaseLineId, originalSaleMovementId: row.originalSale.id, reservationId: row.sale.id } } });
    lines.push({ commercePurchaseLineId: row.line.commercePurchaseLineId, itemId: row.item.id, movementId: movement.id, quantity: row.line.quantity });
  }
  return cancellationRestorationResultSchema.parse({ cancellationId: input.cancellationId, sellerOrderId: input.sellerOrderId, lines });
};
