import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';

import { getInventoryItemCdnUrls } from '@/inventory/services/itemListingService';
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

  const cdnData = await getInventoryItemCdnUrls(id, currentUser);

  return {
    statusCode: StatusCodes.OK,
    body: {
      success: true,
      message: 'Listing CDN URLs retrieved successfully',
      data: cdnData,
    },
    headers: {
      'Cache-Control': 'no-store',
    },
  } as HTTPResponseTypeV2;
};

export const handler = errorMiddleware(authMiddleware(responseMiddleware(baseHandler)));
