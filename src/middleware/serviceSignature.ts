import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

import { assertServiceRequestSignature } from '@/services/serviceRequestSignatureService';

export const serviceSignatureMiddleware = (
  handler: (
    event: APIGatewayProxyEventV2,
    context: unknown,
  ) => Promise<APIGatewayProxyResultV2>,
) => {
  return async (
    event: APIGatewayProxyEventV2,
    context: unknown,
  ): Promise<APIGatewayProxyResultV2> => {
    assertServiceRequestSignature({
      headers: event.headers ?? {},
      body: event.body ?? '',
      pathAndQuery: `${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ''}`,
    });

    return handler(event, context);
  };
};
