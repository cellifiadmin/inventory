import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  ItemKind,
  MovementDirection,
  MovementReason,
} from '@/lib/prismaInventoryTypes';
import type { AuthUserType } from '@/types/userType';

const mockPrismaInventory = {
  item: {
    findUnique: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockCalculateRemainingQuantity = jest.fn();
const mockEnqueueOffersStockSync = jest.fn();

jest.mock('@/lib/prismaInventory', () => ({
  __esModule: true,
  default: mockPrismaInventory,
}));

jest.mock('@/services/stockService', () => ({
  calculateRemainingQuantity: (...args: unknown[]) =>
    mockCalculateRemainingQuantity(...args),
}));

jest.mock('@/services/offersStockSyncQueue', () => ({
  enqueueOffersStockSync: (...args: unknown[]) =>
    mockEnqueueOffersStockSync(...args),
}));

jest.mock('@/inventory/services/personalFallbackCodeService', () => ({
  consumePersonalInventoryFallbackCode: jest.fn(),
}));

jest.mock('@/services/blobService', () => ({
  generatePreviewUrl: jest.fn(),
}));

jest.mock('@/lib/objectStorage', () => ({
  buildRawObjectUrl: jest.fn(),
}));

jest.mock('@/services/userService', () => ({
  getUserInventoryAddress: jest.fn(),
}));

import { updateInventoryItemBoundary } from '@/inventory/services/inventoryItemService';

const createBoundaryItem = () => ({
  id: 12,
  kind: ItemKind.STOCK,
  itemCode: 'B:PHONE:001:1',
  sellerIdentifier: 'acct-1',
  addressLine1: null,
  addressLine2: null,
  addressCity: null,
  addressStateCode: null,
  addressPostalCode: null,
  addressCountryCode: null,
  addressLatitude: null,
  addressLongitude: null,
  deletedAt: null,
  mainImage: null,
  images: [],
  components: [],
});

describe('updateInventoryItemBoundary zero-stock sync', () => {
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

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('enqueues a delist message when an OUT adjustment moves stock to zero', async () => {
    const tx = {
      movement: {
        findMany: jest.fn().mockResolvedValue([
          {
            quantity: 1,
            direction: MovementDirection.IN,
          },
        ]),
        create: jest.fn().mockResolvedValue({
          id: 321,
        }),
      },
      item: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(createBoundaryItem()),
      },
    };

    mockPrismaInventory.item.findUnique.mockResolvedValue(createBoundaryItem());
    mockPrismaInventory.$transaction.mockImplementation(async (callback: any) =>
      callback(tx),
    );
    mockCalculateRemainingQuantity.mockResolvedValue(0);
    mockEnqueueOffersStockSync.mockResolvedValue({
      MessageId: 'sync-1',
    });

    const result = await updateInventoryItemBoundary(user, 12, { quantity: 0 });

    expect(tx.movement.create).toHaveBeenCalledWith({
      data: {
        itemId: 12,
        direction: MovementDirection.OUT,
        reason: MovementReason.ADJUSTED,
        quantity: 1,
      },
    });
    expect(mockEnqueueOffersStockSync).toHaveBeenCalledWith(
      {
        sellerIdentifier: 'acct-1',
        itemCode: 'B:PHONE:001:1',
        direction: 'OUT',
      },
      {
        deduplicationKey: 'movement:321',
      },
    );
    expect(result).toEqual({
      data: {
        resolvedInventoryItem: expect.objectContaining({
          id: 12,
          quantity: 0,
        }),
      },
    });
  });
});
