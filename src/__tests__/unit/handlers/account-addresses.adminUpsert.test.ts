import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

const mockPrismaInventory = {
  accountAddress: {
    upsert: jest.fn(),
  },
};

jest.mock('@/lib/prismaInventory', () => ({
  __esModule: true,
  default: mockPrismaInventory,
}));

import * as accountAddressService from '@/inventory/services/accountAddressService';

const buildEvent = ({
  accountIdentifier = 'acct-owner-1',
  type = 'pickup',
  isAdmin = true,
  userRoles = ['ADMIN'],
  body = {
    line1: ' 123 Market St ',
    line2: ' ',
    city: ' Louisville ',
    stateCode: ' US-KY ',
    postalCode: ' 40202 ',
    countryCode: ' usa ',
    latitude: 38.2527,
    longitude: -85.7585,
    label: ' Pickup hub ',
  },
}: {
  accountIdentifier?: string;
  type?: string;
  isAdmin?: boolean;
  userRoles?: string[];
  body?: unknown;
} = {}): APIGatewayProxyEventV2 =>
  ({
    version: '2.0',
    routeKey: 'PUT /inventory/admin/accounts/{accountIdentifier}/addresses/{type}',
    rawPath: `/inventory/admin/accounts/${accountIdentifier}/addresses/${type}`,
    pathParameters: {
      accountIdentifier,
      type,
    },
    headers: {},
    body: JSON.stringify(body),
    requestContext: {
      http: {
        method: 'PUT',
      },
      authorizer: {
        lambda: {
          authUser: JSON.stringify({
            userIdentifier: 'admin-user-1',
            userName: 'Admin User',
            userRoles,
            accountIdentifier: 'admin-account-1',
            isAdmin,
          }),
        },
      },
    } as APIGatewayProxyEventV2['requestContext'],
    rawQueryString: '',
    isBase64Encoded: false,
  }) as unknown as APIGatewayProxyEventV2;

describe('admin account address writes', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('upserts the target account address by account identifier at the service layer', async () => {
    const createdAt = new Date('2026-07-17T10:00:00.000Z');
    const updatedAt = new Date('2026-07-17T11:00:00.000Z');

    mockPrismaInventory.accountAddress.upsert.mockResolvedValue({
      id: 21,
      accountIdentifier: 'acct-owner-1',
      type: 'WAREHOUSE',
      line1: '123 Market St',
      line2: null,
      city: 'Louisville',
      stateCode: 'US-KY',
      postalCode: '40202',
      countryCode: 'USA',
      latitude: 38.2527,
      longitude: -85.7585,
      label: 'Pickup hub',
      createdAt,
      updatedAt,
      deletedAt: null,
    });

    const upsertAccountAddressByAccountIdentifier = (
      accountAddressService as typeof accountAddressService & {
        upsertAccountAddressByAccountIdentifier?: (params: {
          accountIdentifier: string;
          type: string;
          address: Record<string, unknown>;
        }) => Promise<unknown>;
      }
    ).upsertAccountAddressByAccountIdentifier;

    expect(typeof upsertAccountAddressByAccountIdentifier).toBe('function');

    const result = await upsertAccountAddressByAccountIdentifier!({
      accountIdentifier: ' acct-owner-1 ',
      type: ' warehouse ',
      address: {
        line1: ' 123 Market St ',
        line2: ' ',
        city: ' Louisville ',
        stateCode: ' US-KY ',
        postalCode: ' 40202 ',
        countryCode: ' usa ',
        latitude: 38.2527,
        longitude: -85.7585,
        label: ' Pickup hub ',
      },
    });

    expect(mockPrismaInventory.accountAddress.upsert).toHaveBeenCalledWith({
      where: {
        accountIdentifier_type: {
          accountIdentifier: 'acct-owner-1',
          type: 'WAREHOUSE',
        },
      },
      update: {
        line1: '123 Market St',
        line2: null,
        city: 'Louisville',
        stateCode: 'US-KY',
        postalCode: '40202',
        countryCode: 'USA',
        latitude: 38.2527,
        longitude: -85.7585,
        label: 'Pickup hub',
        deletedAt: null,
      },
      create: {
        accountIdentifier: 'acct-owner-1',
        type: 'WAREHOUSE',
        line1: '123 Market St',
        line2: null,
        city: 'Louisville',
        stateCode: 'US-KY',
        postalCode: '40202',
        countryCode: 'USA',
        latitude: 38.2527,
        longitude: -85.7585,
        label: 'Pickup hub',
      },
    });
    expect(result).toEqual(
      expect.objectContaining({
        id: 21,
        accountIdentifier: 'acct-owner-1',
        type: 'WAREHOUSE',
        line1: '123 Market St',
      }),
    );
  });

  it('allows token-authoritative admins to upsert owner account addresses', async () => {
    const { handler } = require('@/inventory/handlers/account-addresses/adminUpsert') as {
      handler: (
        event: APIGatewayProxyEventV2,
        context: unknown,
      ) => Promise<unknown>;
    };

    const serviceSpy = jest
      .spyOn(
        accountAddressService as typeof accountAddressService & {
          upsertAccountAddressByAccountIdentifier: (...args: Array<unknown>) => Promise<unknown>;
        },
        'upsertAccountAddressByAccountIdentifier',
      )
      .mockResolvedValue({
        id: 22,
        accountIdentifier: 'acct-owner-1',
        addressableId: 'acct-owner-1',
        addressableType: 'Account',
        type: 'PICKUP',
        line1: '123 Market St',
        line2: null,
        city: 'Louisville',
        stateCode: 'US-KY',
        postalCode: '40202',
        countryCode: 'USA',
        latitude: 38.2527,
        longitude: -85.7585,
        label: 'Pickup hub',
        isPrimary: false,
        createdAt: new Date('2026-07-17T10:00:00.000Z'),
        updatedAt: new Date('2026-07-17T11:00:00.000Z'),
        deletedAt: null,
      });

    const response = (await handler(buildEvent(), {})) as any;
    const parsedBody = JSON.parse(String(response.body));

    expect(serviceSpy).toHaveBeenCalledWith({
      accountIdentifier: 'acct-owner-1',
      type: 'pickup',
      address: {
        line1: ' 123 Market St ',
        line2: ' ',
        city: ' Louisville ',
        stateCode: ' US-KY ',
        postalCode: ' 40202 ',
        countryCode: ' usa ',
        latitude: 38.2527,
        longitude: -85.7585,
        label: ' Pickup hub ',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(parsedBody).toEqual({
      success: true,
      message: 'Account address saved successfully',
      data: expect.objectContaining({
        accountIdentifier: 'acct-owner-1',
        type: 'PICKUP',
      }),
    });
  });

  it('rejects non-admin users even when their UM roles include ADMIN', async () => {
    const { handler } = require('@/inventory/handlers/account-addresses/adminUpsert') as {
      handler: (
        event: APIGatewayProxyEventV2,
        context: unknown,
      ) => Promise<unknown>;
    };

    const response = (await handler(
      buildEvent({
        isAdmin: false,
        userRoles: ['ADMIN', 'SUPER_ADMIN'],
      }),
      {},
    )) as any;
    const parsedBody = JSON.parse(String(response.body));

    expect(response.statusCode).toBe(403);
    expect(parsedBody).toEqual(
      expect.objectContaining({
        success: false,
        message: 'Not authorized',
      }),
    );
  });

  it('rejects null request bodies with a 400 before reaching the service layer', async () => {
    const { handler } = require('@/inventory/handlers/account-addresses/adminUpsert') as {
      handler: (
        event: APIGatewayProxyEventV2,
        context: unknown,
      ) => Promise<unknown>;
    };

    const serviceSpy = jest.spyOn(
      accountAddressService as typeof accountAddressService & {
        upsertAccountAddressByAccountIdentifier: (...args: Array<unknown>) => Promise<unknown>;
      },
      'upsertAccountAddressByAccountIdentifier',
    );

    const response = (await handler(
      buildEvent({
        body: null,
      }),
      {},
    )) as any;
    const parsedBody = JSON.parse(String(response.body));

    expect(serviceSpy).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(400);
    expect(parsedBody).toEqual(
      expect.objectContaining({
        success: false,
        message: 'Request body must be an object',
      }),
    );
  });

  it('rejects out-of-range coordinates with a 400', async () => {
    const upsertAccountAddressByAccountIdentifier = (
      accountAddressService as typeof accountAddressService & {
        upsertAccountAddressByAccountIdentifier?: (params: {
          accountIdentifier: string;
          type: string;
          address: Record<string, unknown>;
        }) => Promise<unknown>;
      }
    ).upsertAccountAddressByAccountIdentifier;

    await expect(
      upsertAccountAddressByAccountIdentifier!({
        accountIdentifier: 'acct-owner-1',
        type: 'warehouse',
        address: {
          line1: '123 Market St',
          city: 'Louisville',
          stateCode: 'US-KY',
          postalCode: '40202',
          countryCode: 'USA',
          latitude: 999,
          longitude: -85.7585,
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'latitude must be between -90 and 90',
    });
    expect(mockPrismaInventory.accountAddress.upsert).not.toHaveBeenCalled();
  });
});
