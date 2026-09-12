import { ReservationState, ReservationOperationKind } from '@/constants/reservations';
import { MovementDirection, MovementReason } from '@/lib/prismaInventoryTypes';
import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';
import { reserveStockSchema, type ReserveStockInput } from '@/inventory/types/stockReservationCommands';
import {
  databaseNow, executeReservationOperation, lockStockItems, reservationResult,
  resolveStockReservationTimeoutMinutes, stockBalance, type InventoryStockTransaction,
} from '@/inventory/services/stockReservationShared';

export const reserveStock = async (rawInput: ReserveStockInput, transaction?: InventoryStockTransaction) => {
  const input = reserveStockSchema.parse(rawInput);
  return executeReservationOperation(ReservationOperationKind.RESERVE, input, async tx => {
    const resolved = [];
    for (const line of input.lines) {
      const item = await tx.item.findUnique({ where: { sellerIdentifier_itemCode: {
        sellerIdentifier: line.accountId, itemCode: line.sourceInvId,
      } }, select: { id: true, deletedAt: true } });
      if (!item || item.deletedAt) throw createError(StatusCodes.NOT_FOUND, `Inventory item not found for ${line.sourceInvId}`);
      resolved.push({ line, item });
    }
    await lockStockItems(tx, resolved.map(value => value.item.id));
    const now = await databaseNow(tx);
    const expiresAt = new Date(now.getTime() + resolveStockReservationTimeoutMinutes() * 60000);
    const existing = await tx.stockReservation.findMany({ where: {
      checkoutId: input.checkoutId, checkoutVersion: input.version,
    }, include: { heldMovement: true } });
    // A checkout version has one immutable line set, even when a different command ID is used.
    if (existing.length > 0) {
      if (existing.length !== input.lines.length) throw createError(StatusCodes.CONFLICT, 'Reservation line set changed');
      const records = resolved.map(({ line, item }) => {
        const record = existing.find(value => value.lineId === line.lineId);
        if (!record || record.itemId !== item.id || record.heldMovement.quantity !== line.quantity) {
          throw createError(StatusCodes.CONFLICT, `Reservation input changed for ${line.lineId}`);
        }
        if (record.state !== ReservationState.HELD || record.expiresAt <= now) throw createError(StatusCodes.CONFLICT, 'Reservation is no longer an active hold');
        return record;
      });
      return reservationResult(input.checkoutId, input.version, records);
    }
    const quantities = new Map<number, number>();
    for (const { line, item } of resolved) quantities.set(item.id, (quantities.get(item.id) ?? 0) + line.quantity);
    for (const [itemId, quantity] of quantities) {
      if (await stockBalance(tx, itemId) < quantity) throw createError(StatusCodes.CONFLICT, 'Insufficient inventory available');
    }
    const records = [];
    for (const { line, item } of resolved) {
      const movement = await tx.movement.create({ data: { itemId: item.id, quantity: line.quantity,
        direction: MovementDirection.OUT, reason: MovementReason.RESERVED } });
      records.push(await tx.stockReservation.create({ data: {
        checkoutId: input.checkoutId, checkoutVersion: input.version, lineId: line.lineId,
        itemId: item.id, heldMovementId: movement.id, expiresAt,
      }, include: { heldMovement: true } }));
    }
    return reservationResult(input.checkoutId, input.version, records);
  }, transaction);
};
