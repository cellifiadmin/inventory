import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

const mockReserveStock = jest.fn();

jest.mock('@/inventory/services/stockReservationService', () => ({
  reserveStock: (...args: unknown[]) => mockReserveStock(...args),
}));

const buildEvent = (overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 =>
  ({
    version: '2.0',
    routeKey: 'POST /stock/reserve',
    rawPath: '/stock/reserve',
    headers: {},
    body: JSON.stringify({
      checkoutId: 'chk_123',
      version: 1,
      lines: [
        {
          lineId: 'ln_1',
          accountId: 'acct_seller_1',
          sourceInvId: 'INV-1',
          quantity: 2,
        },
      ],
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

describe('stock reserve handler', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.INTERNAL_SERVICE_REQUEST_SIGNING_SECRET = 'inventory-service-signing-secret';
  });

  it('accepts a signed reserve request and returns the reservation window', async () => {
    mockReserveStock.mockResolvedValue({
      expiresAt: '2026-08-03T18:45:00.000Z',
      lines: [{ lineId: 'ln_1', quantity: 2 }],
    });

    const { createServiceRequestSignature } = require('@/services/serviceRequestSignatureService') as {
      createServiceRequestSignature: (input: { timestamp: string; body: string }) => string;
    };
    const { handler } = require('@/inventory/handlers/stock/reserve') as {
      handler: (event: APIGatewayProxyEventV2, context: unknown) => Promise<unknown>;
    };

    const body = JSON.stringify({
      checkoutId: 'chk_123',
      version: 1,
      lines: [
        {
          lineId: 'ln_1',
          accountId: 'acct_seller_1',
          sourceInvId: 'INV-1',
          quantity: 2,
        },
      ],
    });
    const timestamp = new Date().toISOString();
    const signature = createServiceRequestSignature({ timestamp, body });

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

    expect(mockReserveStock).toHaveBeenCalledWith({
      checkoutId: 'chk_123',
      version: 1,
      lines: [
        {
          lineId: 'ln_1',
          accountId: 'acct_seller_1',
          sourceInvId: 'INV-1',
          quantity: 2,
        },
      ],
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(String(response.body))).toEqual({
      success: true,
      message: 'Stock reserved successfully',
      data: {
        expiresAt: '2026-08-03T18:45:00.000Z',
        lines: [{ lineId: 'ln_1', quantity: 2 }],
      },
    });
  });

  it('rejects unsigned reserve requests', async () => {
    const { handler } = require('@/inventory/handlers/stock/reserve') as {
      handler: (event: APIGatewayProxyEventV2, context: unknown) => Promise<unknown>;
    };

    const response = (await handler(buildEvent(), {})) as any;

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(String(response.body))).toEqual(
      expect.objectContaining({
        success: false,
        message: 'Missing service request signature headers',
      }),
    );
    expect(mockReserveStock).not.toHaveBeenCalled();
  });
});
