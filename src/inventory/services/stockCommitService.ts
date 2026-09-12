import { ReservationState, ReservationOperationKind } from '@/constants/reservations';
import { MovementDirection, MovementReason } from '@/lib/prismaInventoryTypes';
import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';
import {
  commitStockSchema,
  type CommitStockInput,
} from '@/inventory/types/stockReservationCommands';
import {
  executeReservationOperation,
  loadReservationLines,
  reservationResult,
  updateReservation,
  type InventoryStockTransaction,
} from '@/inventory/services/stockReservationShared';

export const commitStock = async (
  rawInput: CommitStockInput,
  transaction?: InventoryStockTransaction,
) => {
  const input = commitStockSchema.parse(rawInput);
  return executeReservationOperation(
    ReservationOperationKind.COMMIT,
    input,
    async (tx) => {
      const records = await loadReservationLines(tx, input);
      for (const record of records) {
        if (
          record.state !== ReservationState.PAYMENT_LOCKED ||
          record.paymentScopeId !== input.paymentScopeId ||
          record.fence !== input.fence
        ) {
          throw createError(StatusCodes.CONFLICT, 'Reservation payment protection mismatch');
        }
      }
      const committed = [];
      for (const record of records) {
        const data = { itemId: record.itemId, quantity: record.heldMovement.quantity };
        const released = await tx.movement.create({
          data: { ...data, direction: MovementDirection.IN, reason: MovementReason.RELEASED },
        });
        const sold = await tx.movement.create({
          data: { ...data, direction: MovementDirection.OUT, reason: MovementReason.SOLD },
        });
        committed.push(
          await updateReservation(tx, record, {
            state: ReservationState.COMMITTED,
            releasedMovementId: released.id,
            soldMovementId: sold.id,
            paymentId: input.paymentId,
            purchaseId: input.purchaseId,
            commerceSellerOrderId: input.commerceSellerOrderId,
          }),
        );
      }
      return {
        snapshot: reservationResult(input.checkoutId, input.version, committed),
        changed: true,
      };
    },
    transaction,
  );
};
