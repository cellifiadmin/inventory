import prismaInventory from '@/lib/prismaInventory';
import { MovementDirection, MovementReason } from '@/lib/prismaInventoryTypes';
import {
  buildLineMetadataFilter,
  buildReservedMovementIdFilter,
  getMetadataDate,
  getMetadataNumber,
  getMetadataString,
  type InventoryStockTransaction,
  type MovementRecord,
} from '@/inventory/services/stockReservationShared';

const isExpiredReservation = (movement: MovementRecord, now: Date): boolean => {
  const expiresAt = getMetadataDate(movement.metadata, 'expiresAt');
  return !!expiresAt && expiresAt.getTime() <= now.getTime();
};

const hasReleaseForReservation = async (
  tx: InventoryStockTransaction,
  reservedMovementId: number,
): Promise<boolean> => {
  const relatedClosures = await tx.movement.findMany({
    where: {
      reason: {
        in: [MovementReason.RELEASED, MovementReason.SOLD],
      },
      AND: [buildReservedMovementIdFilter(reservedMovementId)],
    },
  });

  return relatedClosures.length > 0;
};

export const expireStockReservations = async (input?: { now?: Date }) => {
  const now = input?.now ?? new Date();

  return prismaInventory.$transaction(async (tx) => {
    const reservedMovements = (await tx.movement.findMany({
      where: {
        reason: MovementReason.RESERVED,
      },
      orderBy: { id: 'asc' },
    })) as MovementRecord[];

    const expiredResults: Array<{ lineId: string; reservedMovementId: number; cause: 'expired' }> =
      [];

    for (const reservedMovement of reservedMovements) {
      if (!isExpiredReservation(reservedMovement, now)) {
        continue;
      }

      if (await hasReleaseForReservation(tx, reservedMovement.id)) {
        continue;
      }

      const checkoutId = getMetadataString(reservedMovement.metadata, 'checkoutId');
      const version = getMetadataNumber(reservedMovement.metadata, 'version');
      const lineId = getMetadataString(reservedMovement.metadata, 'lineId');

      if (!checkoutId || version === null || !lineId) {
        continue;
      }

      const duplicateExpiryRelease = await tx.movement.findMany({
        where: {
          reason: MOVEMENT_REASON_RELEASED,
          AND: buildLineMetadataFilter({ checkoutId, version, lineId }),
        },
      });

      if (duplicateExpiryRelease.length > 0) {
        continue;
      }

      await tx.movement.create({
        data: {
          itemId: reservedMovement.itemId,
          quantity: reservedMovement.quantity,
          direction: MovementDirection.IN,
          reason: MOVEMENT_REASON_RELEASED,
          metadata: {
            checkoutId,
            version,
            lineId,
            reservedMovementId: reservedMovement.id,
            cause: 'expired',
          },
        },
      });

      expiredResults.push({
        lineId,
        reservedMovementId: reservedMovement.id,
        cause: 'expired',
      });
    }

    return {
      expiredReservationCount: expiredResults.length,
      lines: expiredResults,
    };
  });
};
const MOVEMENT_REASON_RELEASED = 'RELEASED' as typeof MovementReason.SOLD;
