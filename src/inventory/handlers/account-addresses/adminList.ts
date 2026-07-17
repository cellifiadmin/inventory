import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';

import { listAccountAddressesByAccountIdentifier } from '@/inventory/services/accountAddressService';
import { authMiddleware } from '@/middleware/auth';
import { errorMiddleware } from '@/middleware/errorMiddleware';
import { responseMiddleware } from '@/middleware/responseMiddleware';
import type { HTTPResponseTypeV2 } from '@/types/http';
import type { AuthUserType } from '@/types/userType';

const assertAdminAccess = (authUser: AuthUserType) => {
  if (authUser.isAdmin !== true) {
    throw createError(StatusCodes.FORBIDDEN, 'Not authorized');
  }
};

const requireAccountIdentifier = (event: APIGatewayProxyEventV2) => {
  const accountIdentifier = event.pathParameters?.accountIdentifier?.trim();

  if (!accountIdentifier) {
    throw createError(StatusCodes.BAD_REQUEST, 'Account identifier required');
  }

  return accountIdentifier;
};

const baseHandler = async (
  event: APIGatewayProxyEventV2,
  _context: unknown,
  authUser: AuthUserType,
): Promise<HTTPResponseTypeV2> => {
  assertAdminAccess(authUser);
  const accountIdentifier = requireAccountIdentifier(event);
  const data = await listAccountAddressesByAccountIdentifier(accountIdentifier);

  return {
    statusCode: StatusCodes.OK,
    body: {
      success: true,
      message: 'Account addresses retrieved successfully',
      data,
    },
  } as HTTPResponseTypeV2;
};

export const handler = errorMiddleware(authMiddleware(responseMiddleware(baseHandler)));
