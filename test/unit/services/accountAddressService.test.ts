import type { AccountAddress, Prisma } from '.prisma/inventoryClient';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type AddressTransaction = {
  accountAddress: {
    updateMany(args: Prisma.AccountAddressUpdateManyArgs): Promise<{ count: number }>;
    upsert(args: Prisma.AccountAddressUpsertArgs): Promise<object>;
  };
};

const mockPrismaInventory = {
  accountAddress: {
    findMany: jest.fn<(args: Prisma.AccountAddressFindManyArgs) => Promise<AccountAddress[]>>(),
    upsert: jest.fn<(args: Prisma.AccountAddressUpsertArgs) => Promise<AccountAddress>>(),
    updateMany: jest.fn<(args: Prisma.AccountAddressUpdateManyArgs) => Promise<{ count: number }>>(),
  },
  $transaction: jest.fn<(callback: (tx: AddressTransaction) => Promise<void>) => Promise<void>>(),
};

jest.mock('@/lib/prismaInventory', () => ({
  __esModule: true,
  default: mockPrismaInventory,
}));

import {
  saveAccountAddress,
  upsertApprovedAccountAddresses,
} from '@/inventory/services/accountAddressService';

describe('accountAddressService coordinate ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GOOGLE_MAPS_API_KEY = 'test-google-maps-key';
    mockPrismaInventory.accountAddress.findMany.mockResolvedValue([]);
    global.fetch = jest.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      status: 'OK',
      results: [{ geometry: { location: { lat: 38.2527, lng: -85.7585 } } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  });

  it('geocodes missing coordinates before saving an account address', async () => {
    mockPrismaInventory.accountAddress.upsert.mockResolvedValue({
      id: 1,
      accountIdentifier: 'acct-1',
      type: 'WAREHOUSE',
      line1: '7926 Preston Hwy',
      line2: null,
      city: 'Louisville',
      stateCode: 'US-KY',
      postalCode: '40219',
      countryCode: 'USA',
      latitude: 38.2527,
      longitude: -85.7585,
      label: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });

    await saveAccountAddress({
      authUser: {
        accountIdentifier: 'acct-1',
        userIdentifier: 'user-1',
        userName: 'user',
        userRoles: [],
      },
      type: 'WAREHOUSE',
      address: {
        line1: '7926 Preston Hwy',
        city: 'Louisville',
        stateCode: 'US-KY',
        postalCode: '40219',
        countryCode: 'USA',
      },
    });

    expect(global.fetch).toHaveBeenCalled();
    expect(mockPrismaInventory.accountAddress.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          latitude: 38.2527,
          longitude: -85.7585,
        }),
        create: expect.objectContaining({
          latitude: 38.2527,
          longitude: -85.7585,
        }),
      })
    );
  });

  it('preserves provided coordinates without geocoding', async () => {
    mockPrismaInventory.accountAddress.upsert.mockResolvedValue({
      id: 1,
      accountIdentifier: 'acct-1',
      type: 'WAREHOUSE',
      line1: '7926 Preston Hwy',
      line2: null,
      city: 'Louisville',
      stateCode: 'US-KY',
      postalCode: '40219',
      countryCode: 'USA',
      latitude: 38.2527,
      longitude: -85.7585,
      label: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });

    await saveAccountAddress({
      authUser: {
        accountIdentifier: 'acct-1',
        userIdentifier: 'user-1',
        userName: 'user',
        userRoles: [],
      },
      type: 'WAREHOUSE',
      address: {
        line1: '7926 Preston Hwy',
        city: 'Louisville',
        stateCode: 'US-KY',
        postalCode: '40219',
        countryCode: 'USA',
        latitude: 38.2527,
        longitude: -85.7585,
      },
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockPrismaInventory.accountAddress.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          latitude: 38.2527,
          longitude: -85.7585,
        }),
      })
    );
  });

  it('geocodes missing coordinates during approved-address provisioning', async () => {
    const tx = {
      accountAddress: {
        updateMany: jest.fn<AddressTransaction['accountAddress']['updateMany']>().mockResolvedValue({ count: 0 }),
        upsert: jest.fn<AddressTransaction['accountAddress']['upsert']>().mockResolvedValue({}),
      },
    };
    mockPrismaInventory.$transaction.mockImplementation(async (callback) =>
      callback(tx)
    );

    await upsertApprovedAccountAddresses({
      accountIdentifier: 'acct-1',
      addresses: [
        {
          type: 'WAREHOUSE',
          line1: '7926 Preston Hwy',
          city: 'Louisville',
          stateCode: 'US-KY',
          postalCode: '40219',
          countryCode: 'USA',
        },
      ],
    });

    expect(global.fetch).toHaveBeenCalled();
    expect(tx.accountAddress.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          latitude: 38.2527,
          longitude: -85.7585,
        }),
      })
    );
  });
});
