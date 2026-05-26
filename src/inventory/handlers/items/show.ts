import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';

import { getManageInventoryItemById } from '@/inventory/services/itemListingService';
import { authMiddleware } from '@/middleware/auth';
import { errorMiddleware } from '@/middleware/errorMiddleware';
import { responseMiddleware } from '@/middleware/responseMiddleware';
import type { HTTPResponseTypeV2 } from '@/types/http';
import type { AuthUserType } from '@/types/userType';

const baseHandler = async (
  event: APIGatewayProxyEventV2,
  _context: unknown,
  user: AuthUserType
): Promise<HTTPResponseTypeV2> => {
  const inventoryItemId = event.pathParameters?.id;

  if (!inventoryItemId) {
    throw createError(StatusCodes.BAD_REQUEST, 'Inventory item ID required');
  }

  const inventoryItem = await getManageInventoryItemById(
    Number(inventoryItemId),
    user,
  );

  if (!inventoryItem) {
    throw createError(StatusCodes.NOT_FOUND, 'Inventory item not found');
  }

  return {
    statusCode: StatusCodes.OK,
    body: {
      success: true,
      message: 'Inventory item fetched successfully',
      data: inventoryItem,
    },
  } as HTTPResponseTypeV2;
};

export const handler = errorMiddleware(authMiddleware(responseMiddleware(baseHandler)));
