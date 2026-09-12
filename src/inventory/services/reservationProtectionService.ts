import { ReservationState, ReservationOperationKind } from '@/constants/reservations';
import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';
import { protectReservationsSchema, type ProtectReservationsInput } from '@/inventory/types/stockReservationCommands';
import { databaseNow, executeReservationOperation, loadReservationLines, reservationResult, updateReservation, type InventoryStockTransaction } from '@/inventory/services/stockReservationShared';

export const protectReservations = async (rawInput: ProtectReservationsInput, transaction?: InventoryStockTransaction) => {
  const input = protectReservationsSchema.parse(rawInput);
  return executeReservationOperation(ReservationOperationKind.PROTECT, input, async tx => {
    const records = await loadReservationLines(tx, input);
    const now = await databaseNow(tx);
    for (const record of records) {
      if (record.state !== ReservationState.HELD || record.expiresAt <= now || input.fence <= record.fence) {
        throw createError(StatusCodes.CONFLICT, 'Reservation cannot be payment protected');
      }
    }
    const protectedRecords = [];
    for (const record of records) protectedRecords.push(await updateReservation(tx, record, {
      state: ReservationState.PAYMENT_LOCKED, paymentScopeId: input.paymentScopeId, fence: input.fence,
    }));
    return reservationResult(input.checkoutId, input.version, protectedRecords);
  }, transaction);
};
