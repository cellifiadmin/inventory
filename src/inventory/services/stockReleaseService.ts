import { ReservationState, ReservationOperationKind } from '@/constants/reservations';
import { MovementDirection, MovementReason } from '@/lib/prismaInventoryTypes';
import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';
import {
  releaseStockSchema,
  type ReleaseStockInput,
} from '@/inventory/types/stockReservationCommands';
import {
  databaseNow,
  executeReservationOperation,
  loadReservationLines,
  reservationResult,
  updateReservation,
  type InventoryStockTransaction,
} from '@/inventory/services/stockReservationShared';

export const releaseStock = async (
  rawInput: ReleaseStockInput,
  transaction?: InventoryStockTransaction,
) => {
  const input = releaseStockSchema.parse(rawInput);
  return executeReservationOperation(
    ReservationOperationKind.RELEASE,
    input,
    async (tx) => {
      const records = await loadReservationLines(tx, input);
      const now = await databaseNow(tx);
      for (const record of records) {
        if (
          record.state !== ReservationState.HELD &&
          record.state !== ReservationState.PAYMENT_LOCKED
        )
          throw createError(StatusCodes.CONFLICT, 'Reservation cannot be released');
        if (record.state === ReservationState.PAYMENT_LOCKED) {
          const proof = input.financialResolution;
          if (
            !proof ||
            proof.paymentScopeId !== record.paymentScopeId ||
            proof.fence <= record.fence ||
            new Date(proof.scopeClosedAt) > now
          ) {
            throw createError(StatusCodes.CONFLICT, 'Verified closed payment scope required');
          }
        }
      }
      const released = [];
      for (const record of records) {
        const movement = await tx.movement.create({
          data: {
            itemId: record.itemId,
            quantity: record.heldMovement.quantity,
            direction: MovementDirection.IN,
            reason: MovementReason.RELEASED,
          },
        });
        const proof =
          record.state === ReservationState.PAYMENT_LOCKED ? input.financialResolution : undefined;
        released.push(
          await updateReservation(tx, record, {
            state: ReservationState.RELEASED,
            releasedMovementId: movement.id,
            releaseCause: input.cause,
            ...(proof
              ? {
                  resolutionId: proof.resolutionId,
                  scopeClosedAt: new Date(proof.scopeClosedAt),
                  fence: proof.fence,
                }
              : {}),
          }),
        );
      }
      return {
        snapshot: reservationResult(input.checkoutId, input.version, released),
        changed: true,
      };
    },
    transaction,
  );
};
