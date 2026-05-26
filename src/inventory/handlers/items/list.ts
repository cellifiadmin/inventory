import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { authMiddleware } from '@/middleware/auth';
import { errorMiddleware } from '@/middleware/errorMiddleware';
import { responseMiddleware } from '@/middleware/responseMiddleware';
import { validatePagination, createPaginationResponse } from '@/services/paginationService';
import { validateSorting } from '@/services/sortingService';
import { getInventoryItems } from '@/inventory/services/itemListingService';
import type { HTTPResponseTypeV2 } from '@/types/http';

const VALID_ORDER_FIELDS: string[] = [
  'createdAt',
  'updatedAt',
  'kind',
  'status',
  'code',
];

const buildInventoryItemFilters = (
  queryStringParameters: APIGatewayProxyEventV2['queryStringParameters'],
) => {
  const rawCode = queryStringParameters?.code;

  if (!rawCode) {
    return [];
  }

  const codes = rawCode
    .split(',')
    .map((code) => code.trim())
    .filter((code) => code.length > 0);

  return codes.length > 0 ? [{ code: codes }] : [];
};

const baseHandler = async (
  event: APIGatewayProxyEventV2,
  _context: unknown,
  user: any
): Promise<HTTPResponseTypeV2> => {
  const paginationParams = validatePagination(event.queryStringParameters);
  const filters = buildInventoryItemFilters(event.queryStringParameters);
  const sortingParams = validateSorting(
    event.queryStringParameters,
    VALID_ORDER_FIELDS
  );

  const { data, total, filteredTotal } = await getInventoryItems(
    filters,
    paginationParams,
    sortingParams,
    user
  );

  const pagination = createPaginationResponse(
    total,
    filteredTotal,
    data.length,
    paginationParams
  );

  return {
    statusCode: 200,
    body: {
      success: true,
      message: 'Inventory items fetched successfully',
      data: {
        records: data,
        ...pagination,
      },
    },
  } as HTTPResponseTypeV2;
};

export const handler = errorMiddleware(authMiddleware(responseMiddleware(baseHandler)));
