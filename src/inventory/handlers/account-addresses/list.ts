import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { StatusCodes } from 'http-status-codes';

import { listAccountAddresses } from '@/inventory/services/accountAddressService';
import { authMiddleware } from '@/middleware/auth';
import { errorMiddleware } from '@/middleware/errorMiddleware';
import { responseMiddleware } from '@/middleware/responseMiddleware';
import type { HTTPResponseTypeV2 } from '@/types/http';
import type { AuthUserType } from '@/types/userType';

const baseHandler = async (
  _event: APIGatewayProxyEventV2,
  _context: unknown,
  authUser: AuthUserType,
): Promise<HTTPResponseTypeV2> => {
  const data = await listAccountAddresses({ authUser });

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
