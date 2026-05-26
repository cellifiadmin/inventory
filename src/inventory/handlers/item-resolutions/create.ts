import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { StatusCodes } from 'http-status-codes';

import { resolveInventoryItemBoundary } from '@/inventory/services/inventoryItemService';
import { validateResolveInventoryItemInput } from '@/inventory/validation/validateCreateInventoryItemInput';
import { authMiddleware } from '@/middleware/auth';
import { errorMiddleware } from '@/middleware/errorMiddleware';
import { responseMiddleware } from '@/middleware/responseMiddleware';
import type { HTTPResponseTypeV2 } from '@/types/http';
import type { AuthUserType } from '@/types/userType';

const baseHandler = async (
  event: APIGatewayProxyEventV2,
  _context: unknown,
  currentUser: AuthUserType,
): Promise<HTTPResponseTypeV2> => {
  const body = JSON.parse(event.body || '{}');
  const input = validateResolveInventoryItemInput(body, currentUser);
  const data = await resolveInventoryItemBoundary(currentUser, input);

  return {
    statusCode: StatusCodes.OK,
    body: {
      success: true,
      message: 'Inventory resolved successfully',
      data,
    },
  } as HTTPResponseTypeV2;
};

export const handler = errorMiddleware(authMiddleware(responseMiddleware(baseHandler)));
