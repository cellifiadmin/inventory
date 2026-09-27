import { captureSaleIdentity } from '@/inventory/services/saleIdentityService';
import { ReservationState, ReservationOperationKind } from '@/constants/reservations';
import { MovementDirection, MovementReason } from '@/lib/prismaInventoryTypes';
import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';
import {
  reserveStockSchema,
  type ReserveStockInput,
} from '@/inventory/types/stockReservationCommands';
import {
  databaseNow,
  executeReservationOperation,
  lockStockItems,
  reservationResult,
  stockBalance,
  type InventoryStockTransaction,
} from '@/inventory/services/stockReservationShared';

export const reserveStock = async (
  rawInput: ReserveStockInput,
  transaction?: InventoryStockTransaction,
) => {
  const input = reserveStockSchema.parse(rawInput);
  return executeReservationOperation(
    ReservationOperationKind.RESERVE,
    input,
    async (tx, scope) => {
      const resolved = [];
      for (const line of input.lines) {
        const item = await tx.item.findUnique({
          where: {
            sellerIdentifier_itemCode: {
              sellerIdentifier: line.accountId,
              itemCode: line.sourceInvId,
            },
          },
          select: { id: true, deletedAt: true },
        });
        if (!item || item.deletedAt)
          throw createError(
            StatusCodes.NOT_FOUND,
            `Inventory item not found for ${line.sourceInvId}`,
          );
        resolved.push({ line, item });
      }
      await lockStockItems(
        tx,
        resolved.map((value) => value.item.id),
      );
      const now = await databaseNow(tx);
      const expiresAt = new Date(input.expiresAt);
      if (expiresAt <= now)
        throw createError(StatusCodes.CONFLICT, 'Reservation expiry has elapsed');
      const existing = await tx.stockReservation.findMany({
        where: {
          checkoutId: input.checkoutId,
          checkoutVersion: input.version,
        },
        include: { heldMovement: true },
      });
      if (existing.length) throw new Error('INVENTORY_RESERVE_EVIDENCE_INCONSISTENT');
      const quantities = new Map<number, number>();
      for (const { line, item } of resolved)
        quantities.set(item.id, (quantities.get(item.id) ?? 0) + line.quantity);
      for (const [itemId, quantity] of quantities) {
        if ((await stockBalance(tx, itemId)) < quantity)
          throw createError(StatusCodes.CONFLICT, 'Insufficient inventory available');
      }
      const records = [];
      for (const { line, item } of resolved) {
        const saleIdentity = await captureSaleIdentity(tx, item.id, line.quantity);
        // A ledger read or preceding line write may have consumed the remaining hold time.
        // Any elapsed line aborts the enclosing transaction, including earlier line effects.
        if (expiresAt <= (await databaseNow(tx)))
          throw createError(StatusCodes.CONFLICT, 'Reservation expiry has elapsed');
        const movement = await tx.movement.create({
          data: {
            itemId: item.id,
            quantity: line.quantity,
            direction: MovementDirection.OUT,
            reason: MovementReason.RESERVED,
            metadata: { saleIdentity },
          },
        });
        records.push(
          await tx.stockReservation.create({
            data: {
              checkoutId: input.checkoutId,
              checkoutVersion: input.version,
              lineId: line.lineId,
              scopeLineId: scope.lines.find((value) => value.lineId === line.lineId)!.id,
              itemId: item.id,
              heldMovementId: movement.id,
              expiresAt,
            },
            include: { heldMovement: true },
          }),
        );
      }
      return {
        snapshot: reservationResult(input.checkoutId, input.version, records),
        changed: true,
      };
    },
    transaction,
  );
};
