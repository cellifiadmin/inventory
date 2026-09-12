import {
  ReservationState,
  ReservationOperationKind,
  STOCK_RESERVATION_EXPIRY_BATCH_SIZE,
} from '@/constants/reservations';
import { MovementDirection, MovementReason } from '@/lib/prismaInventoryTypes';
import prismaInventory from '@/lib/prismaInventory';
import {
  databaseNow,
  executeReservationOperation,
  loadReservationLines,
  reservationResult,
  updateReservation,
  withStockTransaction,
} from '@/inventory/services/stockReservationShared';

export const expireStockReservations = async () => {
  const now = await withStockTransaction(databaseNow);
  const candidates = await prismaInventory.stockReservation.findMany({
    where: { state: ReservationState.HELD, expiresAt: { lte: now } },
    orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
    take: STOCK_RESERVATION_EXPIRY_BATCH_SIZE,
  });
  const lines = [];
  for (const candidate of candidates) {
    const input = {
      operationId: `expiry:${candidate.id}:${candidate.revision}`,
      checkoutId: candidate.checkoutId,
      version: candidate.checkoutVersion,
      lines: [
        { reservationId: candidate.id, lineId: candidate.lineId, revision: candidate.revision },
      ],
    };
    try {
      const result = await executeReservationOperation(
        ReservationOperationKind.EXPIRE,
        input,
        async (tx) => {
          const [record] = await loadReservationLines(tx, input);
          const currentTime = await databaseNow(tx);
          if (record.state !== ReservationState.HELD || record.expiresAt > currentTime)
            return {
              snapshot: reservationResult(input.checkoutId, input.version, [record]),
              changed: false,
            };
          const movement = await tx.movement.create({
            data: {
              itemId: record.itemId,
              quantity: record.heldMovement.quantity,
              direction: MovementDirection.IN,
              reason: MovementReason.RELEASED,
            },
          });
          const expired = await updateReservation(tx, record, {
            state: ReservationState.EXPIRED,
            releasedMovementId: movement.id,
            releaseCause: 'expired',
          });
          return {
            snapshot: reservationResult(input.checkoutId, input.version, [expired]),
            changed: true,
          };
        },
      );
      lines.push(...result.lines.filter((line) => line.state === ReservationState.EXPIRED));
    } catch (error) {
      // A protection/terminal transition that won the item lock invalidates this scan candidate.
      if (!(error instanceof Error) || error.message !== 'Reservation revision stale') throw error;
    }
  }
  return { expiredReservationCount: lines.length, lines };
};
