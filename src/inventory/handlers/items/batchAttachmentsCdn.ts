import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';

import { getInventoryItemsBatchCdnUrls } from '@/inventory/services/itemListingService';
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
  const listingIdsParam = event.queryStringParameters?.listingIds;

  if (!listingIdsParam) {
    throw createError(StatusCodes.BAD_REQUEST, 'Missing listingIds query parameter');
  }

  if (listingIdsParam.length > 1000) {
    throw createError(StatusCodes.BAD_REQUEST, 'Query string too long');
  }

  const rawIds = listingIdsParam.split(',').map((id) => id.trim());

  if (rawIds.length === 0) {
    throw createError(StatusCodes.BAD_REQUEST, 'At least one listing ID required');
  }

  const parsedIds = rawIds
    .map((id) => Number(id))
    .filter((id) => !Number.isNaN(id) && id > 0);

  if (parsedIds.length === 0) {
    throw createError(StatusCodes.BAD_REQUEST, 'No valid listing IDs provided');
  }

  const listingIds = Array.from(new Set(parsedIds));

  if (listingIds.length > 50) {
    throw createError(StatusCodes.BAD_REQUEST, 'Maximum 50 unique listings per batch request');
  }

  const attachmentsMap = await getInventoryItemsBatchCdnUrls(
    listingIds,
    currentUser
  );

  return {
    statusCode: StatusCodes.OK,
    body: {
      success: true,
      message: 'Listing attachments retrieved successfully',
      data: { attachments: attachmentsMap },
    },
    headers: {
      'Cache-Control': 'no-store',
    },
  } as HTTPResponseTypeV2;
};

export const handler = errorMiddleware(authMiddleware(responseMiddleware(baseHandler)));
