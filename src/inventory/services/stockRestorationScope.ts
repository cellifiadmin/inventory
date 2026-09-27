import { lockStockItems, type InventoryStockTransaction } from '@/inventory/services/stockReservationShared';
type RestorationScope = { sellerAccountId: string; purchaseId: string; commerceSellerOrderId: string;
  lines: { sourceInvId: string; commercePurchaseLineId: string; quantity: number }[] };
export const loadRestorableSales = async (tx: InventoryStockTransaction, input: RestorationScope) => {
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
      const prior = await tx.movement.aggregate({ where: { itemId: row.item.id, direction: 'IN', reason: { in: ['RETURNED', 'RELEASED'] },
        metadata: { path: ['originalSaleMovementId'], equals: sale.soldMovement.id } }, _sum: { quantity: true } });
      if (row.line.quantity > sale.soldMovement.quantity - (prior._sum.quantity ?? 0))
        throw new Error('RETURN_RESTOCK_SOLD_QUANTITY_EXCEEDED');
      sales.push({ ...row, sale, originalSale: sale.soldMovement });
    }
    return sales;
};
