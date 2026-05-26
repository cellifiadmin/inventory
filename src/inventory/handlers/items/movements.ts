import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';

import { getInventoryItemMovements } from '@/inventory/services/itemListingService';
import { authMiddleware } from '@/middleware/auth';
import { errorMiddleware } from '@/middleware/errorMiddleware';
import { responseMiddleware } from '@/middleware/responseMiddleware';
import {
  createPaginationResponse,
  validatePagination,
} from '@/services/paginationService';
import type { HTTPResponseTypeV2 } from '@/types/http';
import type { AuthUserType } from '@/types/userType';

const baseHandler = async (
  event: APIGatewayProxyEventV2,
  _context: unknown,
  user: AuthUserType,
): Promise<HTTPResponseTypeV2> => {
  const itemId = event.pathParameters?.id;

  if (!itemId) {
    throw createError(StatusCodes.BAD_REQUEST, 'Inventory item ID is required');
  }

  const paginationParams = validatePagination(event.queryStringParameters);
  const { records, aggregation, total, filteredTotal } =
    await getInventoryItemMovements(
    Number.parseInt(itemId, 10),
    paginationParams,
    user,
  );

  const pagination = createPaginationResponse(
    total,
    filteredTotal,
    records.length,
    paginationParams,
  );

  return {
    statusCode: StatusCodes.OK,
    body: {
      success: true,
      message: 'Inventory movements retrieved successfully',
      data: {
        records,
        aggregation,
        ...pagination,
      },
    },
  } as HTTPResponseTypeV2;
};

export const handler = errorMiddleware(authMiddleware(responseMiddleware(baseHandler)));
