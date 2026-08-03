import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';

import prismaInventory from '@/lib/prismaInventory';
import { MovementDirection, MovementReason } from '@/lib/prismaInventoryTypes';
import {
  buildLineMetadataFilter,
  buildReservedMovementIdFilter,
  commitStockSchema,
  type InventoryStockTransaction,
  type CommitStockInput,
  type MovementRecord,
} from '@/inventory/services/stockReservationShared';

const MOVEMENT_REASON_RELEASED = 'RELEASED' as typeof MovementReason.SOLD;

const getActiveReservedMovement = async (
  tx: InventoryStockTransaction,
  input: { checkoutId: string; version: number; lineId: string },
) => {
  const [reservedMovements, soldMovements] = await Promise.all([
    tx.movement.findMany({
      where: {
        reason: MovementReason.RESERVED,
        AND: buildLineMetadataFilter(input),
      },
      orderBy: { id: 'desc' },
    }),
    tx.movement.findMany({
      where: {
        reason: MovementReason.SOLD,
        AND: buildLineMetadataFilter(input),
      },
      orderBy: { id: 'desc' },
    }),
  ]);

  if (soldMovements.length > 0) {
    return { reservedMovement: null, alreadyCommitted: true };
  }

  for (const reservedMovement of reservedMovements as MovementRecord[]) {
    const relatedClosures = await tx.movement.findMany({
      where: {
        reason: {
          in: [MovementReason.RELEASED, MovementReason.SOLD],
        },
        AND: [buildReservedMovementIdFilter(reservedMovement.id)],
      },
    });

    if (relatedClosures.length === 0) {
      return { reservedMovement, alreadyCommitted: false };
    }
  }

  return { reservedMovement: null, alreadyCommitted: false };
};

export const commitStock = async (rawInput: CommitStockInput) => {
  const input = commitStockSchema.parse(rawInput);

  return prismaInventory.$transaction(async (tx) => {
    const results: Array<{ lineId: string; reservedMovementId: number | null }> = [];

    for (const line of input.lines) {
      const { reservedMovement, alreadyCommitted } = await getActiveReservedMovement(tx, {
        checkoutId: input.checkoutId,
        version: input.version,
        lineId: line.lineId,
      });

      if (alreadyCommitted) {
        results.push({
          lineId: line.lineId,
          reservedMovementId: null,
        });
        continue;
      }

      if (!reservedMovement) {
        throw createError(
          StatusCodes.CONFLICT,
          `Active reservation not found for ${line.lineId}`,
        );
      }

      await tx.movement.create({
        data: {
          itemId: reservedMovement.itemId,
          quantity: reservedMovement.quantity,
          direction: MovementDirection.IN,
          reason: MOVEMENT_REASON_RELEASED,
          metadata: {
            checkoutId: input.checkoutId,
            version: input.version,
            lineId: line.lineId,
            reservedMovementId: reservedMovement.id,
            cause: 'commit',
          },
        },
      });

      await tx.movement.create({
        data: {
          itemId: reservedMovement.itemId,
          quantity: reservedMovement.quantity,
          direction: MovementDirection.OUT,
          reason: MovementReason.SOLD,
          metadata: {
            checkoutId: input.checkoutId,
            version: input.version,
            lineId: line.lineId,
            reservedMovementId: reservedMovement.id,
          },
        },
      });

      results.push({
        lineId: line.lineId,
        reservedMovementId: reservedMovement.id,
      });
    }

    return { lines: results };
  });
};
