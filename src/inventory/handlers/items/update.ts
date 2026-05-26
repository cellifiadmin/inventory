import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';

import prismaInventory from '@/lib/prismaInventory';
import { updateInventoryItemListing, validateInventoryItemUpdatePayload } from '@/inventory/services/itemListingService';
import { updateInventoryItemBoundary } from '@/inventory/services/inventoryItemService';
import { validateUpdateInventoryItemInput } from '@/inventory/validation/validateCreateInventoryItemInput';
import { authMiddleware } from '@/middleware/auth';
import { errorMiddleware } from '@/middleware/errorMiddleware';
import { responseMiddleware } from '@/middleware/responseMiddleware';
import type { HTTPResponseTypeV2 } from '@/types/http';
import type { AuthUserType } from '@/types/userType';

const isLegacyListingUpdatePayload = (payload: Record<string, unknown>) => {
  return ['price', 'description', 'availableFrom', 'availableTo', 'minOrderUnits'].some(
    (key) => key in payload
  );
};

const baseHandler = async (
  event: APIGatewayProxyEventV2,
  _context: unknown,
  user: AuthUserType
): Promise<HTTPResponseTypeV2> => {
  const idParam = event.pathParameters?.id;
  const id = Number(idParam);

  if (!idParam || Number.isNaN(id)) {
    throw createError(StatusCodes.BAD_REQUEST, 'Invalid or missing offer ID');
  }

  const body = JSON.parse(event.body || '{}') as Record<string, unknown>;

  if (isLegacyListingUpdatePayload(body)) {
    const validatedPayload = validateInventoryItemUpdatePayload(body);

    const offer = await prismaInventory.offersOffer.findUnique({
      where: { id },
      select: { expiredAt: true },
    });

    if (!offer) {
      throw createError(StatusCodes.NOT_FOUND, 'Offer not found');
    }

    if (offer.expiredAt && offer.expiredAt <= new Date()) {
      throw createError(StatusCodes.FORBIDDEN, 'Listing expired. Clone it to edit');
    }

    await updateInventoryItemListing({
      id,
      ...validatedPayload,
      user,
    });

    return {
      statusCode: StatusCodes.OK,
      body: {
        success: true,
        message: 'Listing Item updated successfully',
        data: {},
      },
    } as HTTPResponseTypeV2;
  }

  const validatedPayload = validateUpdateInventoryItemInput(body);
  const result = await updateInventoryItemBoundary(user, id, validatedPayload);

  return {
    statusCode: StatusCodes.OK,
    body: {
      success: true,
      message: 'Inventory updated successfully',
      data: result.data,
    },
  } as HTTPResponseTypeV2;
};

export const handler = errorMiddleware(authMiddleware(responseMiddleware(baseHandler)));
