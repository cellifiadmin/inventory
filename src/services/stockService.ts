import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';

import prismaInventory from '@/lib/prismaInventory';
import { lockStockItems, stockBalance, withStockTransaction, type InventoryStockTransaction } from '@/inventory/services/stockReservationShared';
import {
  MovementDirection,
  MovementReason,
  Prisma,
} from '@/lib/prismaInventoryTypes';

const applyDirection = (quantity: number, direction: MovementDirection) =>
  direction === MovementDirection.IN ? quantity : -quantity;

export const calculateRemainingQuantity = async (itemId: number): Promise<number> => {
  const movements = await prismaInventory.movement.findMany({
    where: { itemId },
    select: {
      quantity: true,
      direction: true,
    },
  });

  return movements.reduce(
    (total, movement) => total + applyDirection(movement.quantity, movement.direction),
    0,
  );
};

export const findInventoryItemIdByBoundary = async (
  sellerIdentifier: string | null | undefined,
  itemCode: string | null | undefined,
): Promise<number | null> => {
  if (!sellerIdentifier || !itemCode) {
    return null;
  }

  const item = await prismaInventory.item.findUnique({
    where: {
      sellerIdentifier_itemCode: {
        sellerIdentifier,
        itemCode,
      },
    },
    select: {
      id: true,
    },
  });

  return item?.id ?? null;
};

export const calculateRemainingQuantityForBoundary = async (
  sellerIdentifier: string | null | undefined,
  itemCode: string | null | undefined,
): Promise<number> => {
  const itemId = await findInventoryItemIdByBoundary(sellerIdentifier, itemCode);

  if (!itemId) {
    return 0;
  }

  return calculateRemainingQuantity(itemId);
};

export interface CreateStockMovementInput {
  itemId: number;
  quantity: number;
  direction: MovementDirection;
  reason: MovementReason;
  metadata?: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
  createdBy?: number;
}

export const createStockMovement = async (input: CreateStockMovementInput, transaction?: InventoryStockTransaction) => {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw createError(StatusCodes.BAD_REQUEST, 'Invalid quantity');
  }

  return withStockTransaction(async tx => {
    await lockStockItems(tx, [input.itemId]);
    if (input.direction === MovementDirection.OUT && await stockBalance(tx, input.itemId) < input.quantity) {
      throw createError(StatusCodes.BAD_REQUEST, 'Insufficient inventory available');
    }
    return tx.movement.create({ data: {
      itemId: input.itemId, quantity: input.quantity, direction: input.direction, reason: input.reason,
      metadata: input.metadata ?? Prisma.JsonNull, createdBy: input.createdBy ?? null,
    } });
  }, transaction);
};

export const getStockMovements = async (itemId: number) => {
  return prismaInventory.movement.findMany({
    where: { itemId },
    orderBy: { createdAt: 'desc' },
  });
};
