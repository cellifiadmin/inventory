import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { StatusCodes } from 'http-status-codes';

import { commitStock } from '@/inventory/services/stockCommitService';
import { commitStockSchema } from '@/inventory/services/stockReservationShared';
import { serviceSignatureMiddleware } from '@/middleware/serviceSignature';
import { errorMiddleware } from '@/middleware/errorMiddleware';
import { responseMiddleware } from '@/middleware/responseMiddleware';
import type { HTTPResponseTypeV2 } from '@/types/http';

const baseHandler = async (
  event: APIGatewayProxyEventV2,
): Promise<HTTPResponseTypeV2> => {
  const body = event.body ? JSON.parse(event.body) : {};
  const data = await commitStock(commitStockSchema.parse(body));

  return {
    statusCode: StatusCodes.OK,
    body: {
      success: true,
      message: 'Stock committed successfully',
      data,
    },
  } as HTTPResponseTypeV2;
};

export const handler = errorMiddleware(
  serviceSignatureMiddleware(responseMiddleware(baseHandler)),
);
