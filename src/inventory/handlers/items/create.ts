import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { StatusCodes } from 'http-status-codes';

import {
  createInventoryItemBoundary,
  writeInventoryBoundary,
} from '@/inventory/services/inventoryItemService';
import {
  validateCreateInventoryItemInput,
  validateWriteInventoryItemInput,
} from '@/inventory/validation/validateCreateInventoryItemInput';
import { authMiddleware } from '@/middleware/auth';
import { errorMiddleware } from '@/middleware/errorMiddleware';
import { responseMiddleware } from '@/middleware/responseMiddleware';
import type { HTTPResponseTypeV2 } from '@/types/http';
import type { AuthUserType } from '@/types/userType';

const isInventoryWriteRoute = (event: APIGatewayProxyEventV2) => {
  return (
    event.rawPath === '/inventories' ||
    event.requestContext?.http?.path === '/inventories'
  );
};

const baseHandler = async (
  event: APIGatewayProxyEventV2,
  _context: unknown,
  currentUser: AuthUserType
): Promise<HTTPResponseTypeV2> => {
  const body = JSON.parse(event.body || '{}');

  if (isInventoryWriteRoute(event)) {
    const input = validateWriteInventoryItemInput(body, currentUser);
    const result = await writeInventoryBoundary(currentUser, input);

    return {
      statusCode: result.created ? StatusCodes.CREATED : StatusCodes.OK,
      body: {
        success: true,
        message: result.created
          ? 'Inventory created successfully'
          : 'Inventory updated successfully',
        data: result.data,
      },
    } as HTTPResponseTypeV2;
  }

  const input = validateCreateInventoryItemInput(body, currentUser);
  const result = await createInventoryItemBoundary(currentUser, input);

  return {
    statusCode: StatusCodes.CREATED,
    body: {
      success: true,
      message: 'Inventory created successfully',
      data: result.data,
    },
  } as HTTPResponseTypeV2;
};

export const handler = errorMiddleware(authMiddleware(responseMiddleware(baseHandler)));
