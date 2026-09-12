import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';

import { lockStockItems, stockBalance, withStockTransaction } from '@/inventory/services/stockReservationShared';
import {
  MovementDirection,
  MovementReason,
} from '@/lib/prismaInventoryTypes';
import { createStockMovement } from '@/services/stockService';
import { notifyOffersOnZeroStock } from '@/inventory/services/notifyOffersOnZeroStock';
import type { AuthUserType } from '@/types/userType';

type MarkInventoryItemAsSoldResult = {
  inventoryItemId: number;
  itemCode: string;
  remainingQuantity: number;
  soldQuantity: number;
  delistedOfferIds: number[];
};

const requireAccountIdentifier = (user: AuthUserType) => {
  if (!user.accountIdentifier) {
    throw createError(StatusCodes.BAD_REQUEST, 'Seller required');
  }

  return user.accountIdentifier;
};

export const markInventoryItemAsSold = async (
  user: AuthUserType,
  itemId: number,
  quantity?: number,
): Promise<MarkInventoryItemAsSoldResult> => {
  if (
    quantity !== undefined &&
    (!Number.isInteger(quantity) || quantity <= 0)
  ) {
    throw createError(StatusCodes.BAD_REQUEST, 'Invalid quantity');
  }

  const sellerIdentifier = requireAccountIdentifier(user);
  const result = await withStockTransaction(async tx => {
    await lockStockItems(tx, [itemId]);
    const item = await tx.item.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        itemCode: true,
        sellerIdentifier: true,
        deletedAt: true,
      },
    });

    if (!item || item.deletedAt) {
      throw createError(StatusCodes.NOT_FOUND, 'Inventory item not found');
    }

    if (item.sellerIdentifier !== sellerIdentifier) {
      throw createError(StatusCodes.FORBIDDEN, 'Inventory item seller invalid');
    }

    const remainingQuantity = await stockBalance(tx, item.id);

    if (remainingQuantity <= 0) {
      throw createError(StatusCodes.BAD_REQUEST, 'No remaining quantity available');
    }

    const soldQuantity = quantity ?? remainingQuantity;

    if (soldQuantity > remainingQuantity) {
      throw createError(
        StatusCodes.BAD_REQUEST,
        `Insufficient stock. Remaining: ${remainingQuantity}, requested: ${soldQuantity}`,
      );
    }

    const movement = await createStockMovement({
      itemId: item.id,
      quantity: soldQuantity,
      direction: MovementDirection.OUT,
      reason: MovementReason.SOLD,
      metadata: {
        inventoryItemId: item.id,
      },
    }, tx);

    const newRemainingQuantity = remainingQuantity - soldQuantity;
    return { item, remainingQuantity, soldQuantity, movement, newRemainingQuantity };
  });
  const { item, remainingQuantity, soldQuantity, movement, newRemainingQuantity } = result;
  await notifyOffersOnZeroStock({
    sellerIdentifier: item.sellerIdentifier,
    itemCode: item.itemCode,
    direction: MovementDirection.OUT,
    previousQuantity: remainingQuantity,
    nextQuantity: newRemainingQuantity,
    deduplicationKey: `movement:${movement.id}`,
  });

  return {
    inventoryItemId: item.id,
    itemCode: item.itemCode,
    remainingQuantity: newRemainingQuantity,
    soldQuantity,
    delistedOfferIds: [],
  };
};
