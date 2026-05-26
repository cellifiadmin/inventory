import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';

import { saveAccountAddress } from '@/inventory/services/accountAddressService';
import { authMiddleware } from '@/middleware/auth';
import { errorMiddleware } from '@/middleware/errorMiddleware';
import { responseMiddleware } from '@/middleware/responseMiddleware';
import type { HTTPResponseTypeV2 } from '@/types/http';
import type { AuthUserType } from '@/types/userType';

const baseHandler = async (
  event: APIGatewayProxyEventV2,
  _context: unknown,
  authUser: AuthUserType,
): Promise<HTTPResponseTypeV2> => {
  const type = event.pathParameters?.type;
  if (!type) {
    throw createError(StatusCodes.BAD_REQUEST, 'Address type required');
  }

  const body = JSON.parse(event.body || '{}');
  const data = await saveAccountAddress({
    authUser,
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
