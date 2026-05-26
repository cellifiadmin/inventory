import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';

import { markInventoryItemAsSold } from '@/inventory/services/markInventoryItemAsSold';
import { authMiddleware } from '@/middleware/auth';
import { errorMiddleware } from '@/middleware/errorMiddleware';
import { responseMiddleware } from '@/middleware/responseMiddleware';
import type { HTTPResponseTypeV2 } from '@/types/http';
import type { AuthUserType } from '@/types/userType';

const baseHandler = async (
  event: APIGatewayProxyEventV2,
  _context: unknown,
  user: AuthUserType,
): Promise<HTTPResponseTypeV2> => {
  const itemIdParam = event.pathParameters?.id;
  const itemId = Number(itemIdParam);

  if (!itemIdParam || Number.isNaN(itemId)) {
    throw createError(StatusCodes.BAD_REQUEST, 'Invalid or missing inventory item ID');
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || '{}') as Record<string, unknown>;
  } catch {
    throw createError(StatusCodes.BAD_REQUEST, 'Malformed JSON body');
  }
  const rawQuantity = body.quantity;
  const quantity =
    rawQuantity === undefined ? undefined : Number(rawQuantity);

  if (
    quantity !== undefined &&
    (!Number.isInteger(quantity) || quantity <= 0)
  ) {
    throw createError(StatusCodes.BAD_REQUEST, 'Valid quantity is required');
  }

  const result = await markInventoryItemAsSold(user, itemId, quantity);

  return {
    statusCode: StatusCodes.OK,
    body: {
      success: true,
      message: `Successfully marked ${result.soldQuantity} unit(s) as sold`,
      data: result,
    },
  } as HTTPResponseTypeV2;
};

export const handler = errorMiddleware(authMiddleware(responseMiddleware(baseHandler)));
