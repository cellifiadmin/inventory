import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ItemKind } from '@/lib/prismaInventoryTypes';
import type { AuthUserType } from '@/types/userType';

const mockPrismaInventory = {
  item: {
    findFirst: jest.fn(),
  },
  component: {
    findFirst: jest.fn(),
  },
  offersOffer: {
    findFirst: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockGetUserInventoryAddress = jest.fn();

jest.mock('@/lib/prismaInventory', () => ({
  __esModule: true,
  default: mockPrismaInventory,
}));

jest.mock('@/inventory/services/personalFallbackCodeService', () => ({
  consumePersonalInventoryFallbackCode: jest.fn(),
}));

jest.mock('@/services/userService', () => ({
  getUserInventoryAddress: (...args: unknown[]) =>
    mockGetUserInventoryAddress(...args),
}));

jest.mock('@/services/stockService', () => ({
  calculateRemainingQuantity: jest.fn(),
}));

jest.mock('@/services/offersStockSyncQueue', () => ({
  enqueueOffersStockSync: jest.fn(),
  enqueueOffersImageSync: jest.fn(),
}));

jest.mock('@/services/blobService/getCDNUrl', () => ({
  blobKeyToCDNUrl: (key: string) => `https://cdn.dev.cellifi.com/${key}`,
}));

jest.mock('@/lib/objectStorage', () => ({
  buildRawObjectUrl: jest.fn(),
  extractObjectKeyAccountIdentifier: (key: string) => key.split('/')[1] || '',
}));

import {
  createInventoryItemBoundary,
  writeInventoryBoundary,
} from '@/inventory/services/inventoryItemService';

const user: AuthUserType = {
  userIdentifier: 'user-1',
  userName: 'Abdul',
  userRoles: [],
  accountIdentifier: 'acct-1',
  accountName: 'Account 1',
  accountType: 'BUSINESS',
  local: true,
  online: true,
  isAdmin: true,
};

const buildCreatePayload = () => ({
  kind: ItemKind.LISTING,
  components: [
    {
      sku: 'SKU-1',
      count: 1,
      productType: 'PHONE' as const,
      productSnapshot: {
        sellerIdentifier: 'acct-1',
        sku: 'SKU-1',
        batteryLevel: 95,
        brand: { key: '001', name: 'Apple' },
        model: { key: '0008', name: 'iPhone 14' },
        color: { key: '0017', name: 'Purple', hexValue: '#B8A7EA' },
        storage: { key: '04', name: '512 GB' },
        condition: { key: '002', label: 'Used - Like New' },
        carrier: null,
      },
    },
  ],
  photos: [],
});

describe('createInventoryItemBoundary photo requirements', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrismaInventory.item.findFirst.mockResolvedValue(null);
  });

  it('rejects direct creates when no finalized photos are provided', async () => {
    await expect(
      createInventoryItemBoundary(user, buildCreatePayload()),
    ).rejects.toThrow('At least one photo is required');

    expect(mockGetUserInventoryAddress).not.toHaveBeenCalled();
    expect(mockPrismaInventory.$transaction).not.toHaveBeenCalled();
  });

  it('rejects write-create flows when no finalized photos are provided', async () => {
    await expect(
      writeInventoryBoundary(user, buildCreatePayload()),
    ).rejects.toThrow('At least one photo is required');

    expect(mockGetUserInventoryAddress).not.toHaveBeenCalled();
    expect(mockPrismaInventory.$transaction).not.toHaveBeenCalled();
  });
});
