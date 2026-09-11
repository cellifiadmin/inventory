import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@/inventory/services/markInventoryItemAsSold', () => ({
  markInventoryItemAsSold: jest.fn(),
}));

const mockMarkInventoryItemAsSold =
  jest.mocked(
    jest.requireMock<typeof import('@/inventory/services/markInventoryItemAsSold')>('@/inventory/services/markInventoryItemAsSold')
      .markInventoryItemAsSold,
  );

import { handler } from '@/inventory/handlers/mark-as-sold';

describe('mark-as-sold handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 400 for malformed JSON bodies', async () => {
    const response = await handler(
      {
        body: '{quantity: 1}',
        pathParameters: { id: '4' },
        requestContext: {
          authorizer: {
            lambda: {
              authUser: JSON.stringify({
                userIdentifier: 'user-1',
                userName: 'Abdul',
                userRoles: [],
                accountIdentifier: 'acct-1',
                accountName: 'Account 1',
                accountType: 'BUSINESS',
                local: true,
                online: true,
                isAdmin: true,
              }),
            },
          },
        },
      } as any,
      {} as any,
    );

    if (typeof response !== 'object' || response === null) {
      throw new Error('Expected a structured API Gateway response');
    }
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body as string)).toEqual(
      expect.objectContaining({
        success: false,
        message: 'Malformed JSON body',
      }),
    );
  });

  it('allows quantity to be omitted and reports the sold balance', async () => {
    mockMarkInventoryItemAsSold.mockResolvedValue({
      inventoryItemId: 4,
      itemCode: 'B:PHONE:001:1',
      remainingQuantity: 0,
      soldQuantity: 3,
      delistedOfferIds: [],
    });

    const response = await handler(
      {
        body: '{}',
        pathParameters: { id: '4' },
        requestContext: {
          authorizer: {
            lambda: {
              authUser: JSON.stringify({
                userIdentifier: 'user-1',
                userName: 'Abdul',
                userRoles: [],
                accountIdentifier: 'acct-1',
                accountName: 'Account 1',
                accountType: 'BUSINESS',
                local: true,
                online: true,
                isAdmin: true,
              }),
            },
          },
        },
      } as any,
      {} as any,
    );

    expect(mockMarkInventoryItemAsSold).toHaveBeenCalledWith(
      expect.objectContaining({
        accountIdentifier: 'acct-1',
      }),
      4,
      undefined,
    );
    if (typeof response !== 'object' || response === null) {
      throw new Error('Expected a structured API Gateway response');
    }
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body as string)).toEqual(
      expect.objectContaining({
        success: true,
        message: 'Successfully marked 3 unit(s) as sold',
      }),
    );
  });
});
