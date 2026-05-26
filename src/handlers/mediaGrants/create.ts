import { APIGatewayProxyEventV2 } from 'aws-lambda';
import { z } from 'zod';

import { errorMiddleware } from '@/middleware/errorMiddleware';
import { authMiddleware } from '@/middleware/auth';
import { responseMiddleware } from '@/middleware/responseMiddleware';
import { HTTPResponseTypeV2 } from '@/types/http';
import {
  INVENTORY_MEDIA_LISTING_PHOTO_USAGE,
  createInventoryListingPhotoMediaGrant,
} from '@/services/media/mediaGrantService';

const createMediaGrantSchema = z.object({
  usage: z
    .literal(INVENTORY_MEDIA_LISTING_PHOTO_USAGE)
    .optional()
    .default(INVENTORY_MEDIA_LISTING_PHOTO_USAGE),
});

const baseHandler = async (
  event: APIGatewayProxyEventV2,
  _context: any,
  user: { accountIdentifier: string },
): Promise<HTTPResponseTypeV2> => {
  const body = event.body ? JSON.parse(event.body) : {};
  createMediaGrantSchema.parse(body);

  return {
    statusCode: 200,
    body: {
      success: true,
      message: 'Media grant created successfully',
      data: {
        mediaGrant: createInventoryListingPhotoMediaGrant(user),
      },
    },
  } as HTTPResponseTypeV2;
};

export const handler = errorMiddleware(
  authMiddleware(responseMiddleware(baseHandler)),
);
