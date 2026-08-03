import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';

import prismaInventory from '@/lib/prismaInventory';
import { MovementDirection, MovementReason } from '@/lib/prismaInventoryTypes';
import {
  assertLineNotCommitted,
  assertPositiveAvailableUnits,
  buildLineMetadataFilter,
  buildReservedMovementIdFilter,
  calculateMovementBalance,
  getMetadataDate,
  isReservationActive,
  reserveStockSchema,
  resolveStockReservationTimeoutMinutes,
  type InventoryStockTransaction,
  type MovementRecord,
  type ReserveStockInput,
} from '@/inventory/services/stockReservationShared';

const resolveReservationExpiry = (now: Date): Date => {
  const timeoutMinutes = resolveStockReservationTimeoutMinutes();
  return new Date(now.getTime() + timeoutMinutes * 60 * 1000);
};

const getItemByBoundary = async (
  tx: InventoryStockTransaction,
  accountId: string,
  sourceInvId: string,
) => {
  const item = await tx.item.findUnique({
    where: {
      sellerIdentifier_itemCode: {
        sellerIdentifier: accountId,
        itemCode: sourceInvId,
      },
    },
    select: {
      id: true,
      deletedAt: true,
    },
  });

  if (!item || item.deletedAt) {
    throw createError(StatusCodes.NOT_FOUND, `Inventory item not found for ${sourceInvId}`);
  }

  return item;
};

const getLineScopedMovements = async (
  tx: InventoryStockTransaction,
  input: { checkoutId: string; version: number; lineId: string },
): Promise<{
  reservedMovements: MovementRecord[];
  releaseMovements: MovementRecord[];
  soldMovements: MovementRecord[];
}> => {
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

export const reserveStock = async (rawInput: ReserveStockInput) => {
  const input = reserveStockSchema.parse(rawInput);

  return prismaInventory.$transaction(async (tx) => {
    const now = new Date();
    const expiresAt = resolveReservationExpiry(now);
    const linesToCreate: Array<{
      itemId: number;
      lineId: string;
      quantity: number;
    }> = [];
    let existingReservationExpiry: Date | null = null;

    for (const line of input.lines) {
      const item = await getItemByBoundary(tx, line.accountId, line.sourceInvId);
      const [itemMovements, lineScopedMovements] = await Promise.all([
        tx.movement.findMany({
          where: {
            itemId: item.id,
          },
        }),
        getLineScopedMovements(tx, {
          checkoutId: input.checkoutId,
          version: input.version,
          lineId: line.lineId,
        }),
      ]);

      assertLineNotCommitted(lineScopedMovements.soldMovements, line.lineId);

      const activeReservation = lineScopedMovements.reservedMovements.find((movement) =>
        isReservationActive({
          reservedMovementId: movement.id,
          releaseMovements: lineScopedMovements.releaseMovements,
          soldMovements: lineScopedMovements.soldMovements,
        }),
      );

      if (activeReservation) {
        existingReservationExpiry =
          getMetadataDate(activeReservation.metadata, 'expiresAt') ?? existingReservationExpiry;
        continue;
      }

      const availableUnits = calculateMovementBalance(itemMovements as MovementRecord[]);
      assertPositiveAvailableUnits(availableUnits, line.quantity, line.sourceInvId);

      linesToCreate.push({
        itemId: item.id,
        lineId: line.lineId,
        quantity: line.quantity,
      });
    }

    for (const line of linesToCreate) {
      await tx.movement.create({
        data: {
          itemId: line.itemId,
          quantity: line.quantity,
          direction: MovementDirection.OUT,
          reason: MovementReason.RESERVED,
          metadata: {
            checkoutId: input.checkoutId,
            version: input.version,
            lineId: line.lineId,
            expiresAt: expiresAt.toISOString(),
          },
        },
      });
    }

    return {
      expiresAt: (existingReservationExpiry ?? expiresAt).toISOString(),
      lines: input.lines.map((line) => ({
        lineId: line.lineId,
        quantity: line.quantity,
      })),
    };
  });
};
