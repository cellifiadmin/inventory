import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

const mockReleaseStock = jest.fn();

jest.mock('@/inventory/services/stockReleaseService', () => ({
  releaseStock: (...args: unknown[]) => mockReleaseStock(...args),
}));

const buildEvent = (overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 =>
  ({
    version: '2.0',
    routeKey: 'POST /stock/release',
    rawPath: '/stock/release',
    headers: {},
    body: JSON.stringify({
      checkoutId: 'chk_123',
      version: 1,
      cause: 'payment_failed',
      lines: [{ lineId: 'ln_1' }],
    }),
    requestContext: {
      http: {
        method: 'POST',
      },
    } as APIGatewayProxyEventV2['requestContext'],
    rawQueryString: '',
    isBase64Encoded: false,
    ...overrides,
  }) as APIGatewayProxyEventV2;

describe('stock release handler', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.INTERNAL_SERVICE_REQUEST_SIGNING_SECRET = 'inventory-service-signing-secret';
  });

  it('releases a signed reservation request', async () => {
    mockReleaseStock.mockResolvedValue({
      lines: [{ lineId: 'ln_1', reservedMovementId: 31, cause: 'payment_failed' }],
    });

    const { createServiceRequestSignature } = require('@/services/serviceRequestSignatureService') as {
      createServiceRequestSignature: (input: {
        timestamp: string;
        body: string;
        pathAndQuery?: string;
      }) => string;
    };
    const { handler } = require('@/inventory/handlers/stock/release') as {
      handler: (event: APIGatewayProxyEventV2, context: unknown) => Promise<unknown>;
    };

    const body = JSON.stringify({
      checkoutId: 'chk_123',
      version: 1,
      cause: 'payment_failed',
      lines: [{ lineId: 'ln_1' }],
    });
    const timestamp = new Date().toISOString();
    const signature = createServiceRequestSignature({
      timestamp,
      body,
      pathAndQuery: '/stock/release',
    });

    const response = (await handler(
      buildEvent({
        body,
        headers: {
          'x-mp-timestamp': timestamp,
          'x-mp-signature': signature,
        },
      }),
      {},
    )) as any;

    expect(mockReleaseStock).toHaveBeenCalledWith({
      checkoutId: 'chk_123',
      version: 1,
      cause: 'payment_failed',
      lines: [{ lineId: 'ln_1' }],
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(String(response.body))).toEqual({
      success: true,
      message: 'Stock released successfully',
      data: {
        lines: [{ lineId: 'ln_1', reservedMovementId: 31, cause: 'payment_failed' }],
      },
    });
  });
});
