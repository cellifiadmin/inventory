import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';

import prismaInventory from '@/lib/prismaInventory';
import { MovementDirection, MovementReason } from '@/lib/prismaInventoryTypes';
import {
  buildLineMetadataFilter,
  buildReservedMovementIdFilter,
  releaseStockSchema,
  type InventoryStockTransaction,
  type MovementRecord,
  type ReleaseStockInput,
} from '@/inventory/services/stockReservationShared';

const MOVEMENT_REASON_RELEASED = 'RELEASED' as typeof MovementReason.SOLD;

const getLineReleaseState = async (
  tx: InventoryStockTransaction,
  input: { checkoutId: string; version: number; lineId: string },
) => {
  const [reservedMovements, releaseMovements, soldMovements] = await Promise.all([
    tx.movement.findMany({
      where: {
        reason: MovementReason.RESERVED,
        AND: buildLineMetadataFilter(input),
      },
      orderBy: { id: 'desc' },
    }),
    tx.movement.findMany({
      where: {
        reason: MovementReason.RELEASED,
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

  return {
    reservedMovements: (reservedMovements ?? []) as MovementRecord[],
    releaseMovements: (releaseMovements ?? []) as MovementRecord[],
    soldMovements: (soldMovements ?? []) as MovementRecord[],
  };
};

export const releaseStock = async (rawInput: ReleaseStockInput) => {
  const input = releaseStockSchema.parse(rawInput);

  return prismaInventory.$transaction(async (tx) => {
    const results: Array<{ lineId: string; reservedMovementId: number | null; cause: string }> = [];

    for (const line of input.lines) {
      const state = await getLineReleaseState(tx, {
        checkoutId: input.checkoutId,
        version: input.version,
        lineId: line.lineId,
      });

      if (state.soldMovements.length > 0) {
        throw createError(
          StatusCodes.CONFLICT,
          `Committed stock cannot be released for ${line.lineId}`,
        );
      }

      let reservedMovement: MovementRecord | undefined;

      for (const candidate of state.reservedMovements) {
        const relatedReleases = await tx.movement.findMany({
          where: {
            reason: MovementReason.RELEASED,
            AND: [buildReservedMovementIdFilter(candidate.id)],
          },
        });

        if ((relatedReleases ?? []).length === 0) {
          reservedMovement = candidate;
          break;
        }
      }

      if (!reservedMovement) {
        if (state.releaseMovements.length > 0) {
          results.push({
            lineId: line.lineId,
            reservedMovementId: null,
            cause: input.cause,
          });
          continue;
        }

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
            cause: input.cause,
          },
        },
      });

      results.push({
        lineId: line.lineId,
        reservedMovementId: reservedMovement.id,
        cause: input.cause,
      });
    }

    return { lines: results };
  });
};
