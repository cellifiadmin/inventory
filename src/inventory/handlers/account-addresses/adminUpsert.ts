import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';

import { upsertAccountAddressByAccountIdentifier } from '@/inventory/services/accountAddressService';
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

const parseAddressBody = (event: APIGatewayProxyEventV2) => {
  try {
    const parsedBody = event.body ? JSON.parse(event.body) : {};

    if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
      throw createError(StatusCodes.BAD_REQUEST, 'Request body must be an object');
    }

    return parsedBody;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw createError(StatusCodes.BAD_REQUEST, 'Invalid JSON body');
    }

    throw error;
  }
};

const baseHandler = async (
  event: APIGatewayProxyEventV2,
  _context: unknown,
  authUser: AuthUserType,
): Promise<HTTPResponseTypeV2> => {
  assertAdminAccess(authUser);

  const accountIdentifier = requireAccountIdentifier(event);
  const type = event.pathParameters?.type;

  if (!type) {
    throw createError(StatusCodes.BAD_REQUEST, 'Address type required');
  }

  const body = parseAddressBody(event);
  const data = await upsertAccountAddressByAccountIdentifier({
    accountIdentifier,
    type,
    address: body,
  });

  return {
    statusCode: StatusCodes.OK,
    body: {
      success: true,
      message: 'Account address saved successfully',
      data,
    },
  } as HTTPResponseTypeV2;
};

export const handler = errorMiddleware(authMiddleware(responseMiddleware(baseHandler)));
