import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';

import prismaInventory from '@/lib/prismaInventory';
import { MovementDirection, MovementReason } from '@/lib/prismaInventoryTypes';
import {
  assertLineNotCommitted,
  assertPositiveAvailableUnits,
  buildLineMetadataFilter,
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
    const scope = JSON.stringify(['inventory-reservation', input.checkoutId, input.version]);
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${scope}, 0))`;
    const resolved = [];
    for (const line of input.lines) {
      resolved.push({ line, item: await getItemByBoundary(tx, line.accountId, line.sourceInvId) });
    }
    const distinctItems = new Map(resolved.map(value => [value.item.id, value]));
    for (const { line, item } of [...distinctItems.values()].sort((a, b) => a.item.id - b.item.id)) {
      const locked = await tx.$queryRaw<Array<{ id: number }>>`
        SELECT id FROM items WHERE id = ${item.id} AND deleted_at IS NULL FOR UPDATE`;
      if (locked.length !== 1) throw createError(StatusCodes.NOT_FOUND, `Inventory item not found for ${line.sourceInvId}`);
    }
    const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const expiresAt = resolveReservationExpiry(now);
    const linesToCreate: Array<{
      itemId: number;
      lineId: string;
      quantity: number;
    }> = [];
    let existingReservationExpiry: Date | null = null;

    const pendingQuantityByItem = new Map<number, number>();
    for (const { line, item } of resolved) {
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
        if (activeReservation.itemId !== item.id || activeReservation.quantity !== line.quantity) {
          throw createError(StatusCodes.CONFLICT, `Reservation input changed for ${line.lineId}`);
        }
        const activeExpiry = getMetadataDate(activeReservation.metadata, 'expiresAt');
        if (!activeExpiry || activeExpiry <= now) {
          throw createError(StatusCodes.CONFLICT, `Reservation expiry invalid or elapsed for ${line.lineId}`);
        }
        if (existingReservationExpiry === null || activeExpiry < existingReservationExpiry) existingReservationExpiry = activeExpiry;
        continue;
      }

      const availableUnits = calculateMovementBalance(itemMovements as MovementRecord[]);
      const requestedQuantity = (pendingQuantityByItem.get(item.id) ?? 0) + line.quantity;
      assertPositiveAvailableUnits(availableUnits, requestedQuantity, line.sourceInvId);
      pendingQuantityByItem.set(item.id, requestedQuantity);

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

    if (existingReservationExpiry && linesToCreate.length > 0 && expiresAt < existingReservationExpiry) {
      existingReservationExpiry = expiresAt;
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
