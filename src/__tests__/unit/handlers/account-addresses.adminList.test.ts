import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

const mockPrismaInventory = {
  accountAddress: {
    findMany: jest.fn(),
  },
};

jest.mock('@/lib/prismaInventory', () => ({
  __esModule: true,
  default: mockPrismaInventory,
}));

import * as accountAddressService from '@/inventory/services/accountAddressService';
import { handler } from '@/inventory/handlers/account-addresses/adminList';

const buildEvent = ({
  accountIdentifier = 'acct-owner-1',
  isAdmin = true,
  userRoles = ['ADMIN'],
}: {
  accountIdentifier?: string;
  isAdmin?: boolean;
  userRoles?: string[];
} = {}): APIGatewayProxyEventV2 =>
  ({
    version: '2.0',
    routeKey: 'GET /inventory/admin/accounts/{accountIdentifier}/addresses',
    rawPath: `/inventory/admin/accounts/${accountIdentifier}/addresses`,
    pathParameters: {
      accountIdentifier,
    },
    headers: {},
    requestContext: {
      http: {
        method: 'GET',
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

describe('admin account address reads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists current account addresses by account identifier at the service layer', async () => {
    const createdAt = new Date('2026-07-17T10:00:00.000Z');
    const updatedAt = new Date('2026-07-17T11:00:00.000Z');

    mockPrismaInventory.accountAddress.findMany.mockResolvedValue([
      {
        id: 10,
        accountIdentifier: 'acct-owner-1',
        type: 'PICKUP',
        line1: '123 Market St',
        line2: null,
        city: 'Louisville',
        stateCode: 'US-KY',
        postalCode: '40202',
        countryCode: 'USA',
        latitude: 38.2527,
        longitude: -85.7585,
        label: 'Pickup',
        createdAt,
        updatedAt,
        deletedAt: null,
      },
      {
        id: 11,
        accountIdentifier: 'acct-owner-1',
        type: 'WAREHOUSE',
        line1: '456 Warehouse Rd',
        line2: 'Suite B',
        city: 'Louisville',
        stateCode: 'US-KY',
        postalCode: '40219',
        countryCode: 'USA',
        latitude: 38.1706,
        longitude: -85.7369,
        label: 'Main warehouse',
        createdAt,
        updatedAt,
        deletedAt: null,
      },
    ]);

    const result =
      await accountAddressService.listAccountAddressesByAccountIdentifier(
        ' acct-owner-1 ',
      );

    expect(mockPrismaInventory.accountAddress.findMany).toHaveBeenCalledWith({
      where: {
        accountIdentifier: 'acct-owner-1',
        type: {
          in: ['WAREHOUSE', 'PICKUP'],
        },
        deletedAt: null,
      },
      orderBy: [{ type: 'asc' }],
    });
    expect(result).toEqual([
      expect.objectContaining({
        id: 10,
        accountIdentifier: 'acct-owner-1',
        addressableId: 'acct-owner-1',
        addressableType: 'Account',
        type: 'PICKUP',
        isPrimary: false,
      }),
      expect.objectContaining({
        id: 11,
        accountIdentifier: 'acct-owner-1',
        addressableId: 'acct-owner-1',
        addressableType: 'Account',
        type: 'WAREHOUSE',
        isPrimary: true,
      }),
    ]);
  });

  it('allows token-authoritative admins to read owner account addresses', async () => {
    const serviceSpy = jest
      .spyOn(accountAddressService, 'listAccountAddressesByAccountIdentifier')
      .mockResolvedValue([
        {
          id: 11,
          accountIdentifier: 'acct-owner-1',
          addressableId: 'acct-owner-1',
          addressableType: 'Account',
          type: 'WAREHOUSE',
          line1: '456 Warehouse Rd',
          line2: null,
          city: 'Louisville',
          stateCode: 'US-KY',
          postalCode: '40219',
          countryCode: 'USA',
          latitude: 38.1706,
          longitude: -85.7369,
          label: 'Main warehouse',
          isPrimary: true,
          createdAt: new Date('2026-07-17T10:00:00.000Z'),
          updatedAt: new Date('2026-07-17T11:00:00.000Z'),
          deletedAt: null,
        },
      ]);

    const response = (await handler(buildEvent(), {})) as any;
    const parsedBody = JSON.parse(String(response.body));

    expect(serviceSpy).toHaveBeenCalledWith('acct-owner-1');
    expect(response.statusCode).toBe(200);
    expect(parsedBody).toEqual({
      success: true,
      message: 'Account addresses retrieved successfully',
      data: [
        expect.objectContaining({
          accountIdentifier: 'acct-owner-1',
          type: 'WAREHOUSE',
        }),
      ],
    });
  });

  it('rejects non-admin users even when their UM roles include ADMIN', async () => {
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
});
