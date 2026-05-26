import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';

import { getInventoryItemForEdit } from '@/inventory/services/itemListingService';
import { authMiddleware } from '@/middleware/auth';
import { errorMiddleware } from '@/middleware/errorMiddleware';
import { responseMiddleware } from '@/middleware/responseMiddleware';
import type { HTTPResponseTypeV2 } from '@/types/http';
import type { AuthUserType } from '@/types/userType';

const baseHandler = async (
  event: APIGatewayProxyEventV2,
  _context: unknown,
  currentUser: AuthUserType
): Promise<HTTPResponseTypeV2> => {
  const idParam = event.pathParameters?.id;
  const id = Number(idParam);

  if (!idParam || Number.isNaN(id)) {
    throw createError(StatusCodes.BAD_REQUEST, 'Invalid or missing listing ID');
  }

  const listingData = await getInventoryItemForEdit(id, currentUser);

  return {
    statusCode: StatusCodes.OK,
    body: {
      success: true,
      message: 'Listing retrieved successfully',
      data: listingData,
    },
  } as HTTPResponseTypeV2;
};

export const handler = errorMiddleware(authMiddleware(responseMiddleware(baseHandler)));
