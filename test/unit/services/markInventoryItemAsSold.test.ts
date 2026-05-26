import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockPrismaInventory = {
  item: {
    findUnique: jest.fn(),
  },
};

const mockCalculateRemainingQuantity = jest.fn();
const mockCreateStockMovement = jest.fn();
const mockEnqueueOffersStockSync = jest.fn();

jest.mock('@/lib/prismaInventory', () => ({
  __esModule: true,
  default: mockPrismaInventory,
}));

jest.mock('@/services/stockService', () => ({
  calculateRemainingQuantity: (...args: unknown[]) =>
    mockCalculateRemainingQuantity(...args),
  createStockMovement: (...args: unknown[]) =>
    mockCreateStockMovement(...args),
}));

jest.mock('@/services/offersStockSyncQueue', () => ({
  enqueueOffersStockSync: (...args: unknown[]) =>
    mockEnqueueOffersStockSync(...args),
}));

import { markInventoryItemAsSold } from '@/inventory/services/markInventoryItemAsSold';
import type { AuthUserType } from '@/types/userType';

describe('markInventoryItemAsSold', () => {
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

  it('creates the sold movement without notifying offers when stock remains positive', async () => {
    mockPrismaInventory.item.findUnique.mockResolvedValue({
      id: 12,
      itemCode: 'B:PHONE:001:1',
      sellerIdentifier: 'acct-1',
      deletedAt: null,
    });
    mockCalculateRemainingQuantity.mockResolvedValue(3);
    mockCreateStockMovement.mockResolvedValue({
      id: 99,
    });
    mockEnqueueOffersStockSync.mockResolvedValue({
      MessageId: 'sync-1',
    });

    await expect(markInventoryItemAsSold(user, 12, 1)).resolves.toEqual({
      inventoryItemId: 12,
      itemCode: 'B:PHONE:001:1',
      remainingQuantity: 2,
      soldQuantity: 1,
      delistedOfferIds: [],
    });

    expect(mockCreateStockMovement).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 12,
        quantity: 1,
      }),
    );
    expect(mockEnqueueOffersStockSync).not.toHaveBeenCalled();
  });

  it('enqueues a zero-stock delist message when the sold movement exhausts stock', async () => {
    mockPrismaInventory.item.findUnique.mockResolvedValue({
      id: 12,
      itemCode: 'B:PHONE:001:1',
      sellerIdentifier: 'acct-1',
      deletedAt: null,
    });
    mockCalculateRemainingQuantity.mockResolvedValue(3);
    mockCreateStockMovement.mockResolvedValue({
      id: 199,
    });
    mockEnqueueOffersStockSync.mockResolvedValue({
      MessageId: 'sync-2',
    });

    await expect(markInventoryItemAsSold(user, 12, 3)).resolves.toEqual({
      inventoryItemId: 12,
      itemCode: 'B:PHONE:001:1',
      remainingQuantity: 0,
      soldQuantity: 3,
      delistedOfferIds: [],
    });

    expect(mockEnqueueOffersStockSync).toHaveBeenCalledWith(
      {
        sellerIdentifier: 'acct-1',
        itemCode: 'B:PHONE:001:1',
        direction: 'OUT',
      },
      {
        deduplicationKey: 'movement:199',
      },
    );
  });

  it('sells the full remaining balance when quantity is omitted', async () => {
    mockPrismaInventory.item.findUnique.mockResolvedValue({
      id: 12,
      itemCode: 'B:PHONE:001:1',
      sellerIdentifier: 'acct-1',
      deletedAt: null,
    });
    mockCalculateRemainingQuantity.mockResolvedValue(4);
    mockCreateStockMovement.mockResolvedValue({
      id: 299,
    });
    mockEnqueueOffersStockSync.mockResolvedValue({
      MessageId: 'sync-3',
    });

    await expect(markInventoryItemAsSold(user, 12)).resolves.toEqual({
      inventoryItemId: 12,
      itemCode: 'B:PHONE:001:1',
      remainingQuantity: 0,
      soldQuantity: 4,
      delistedOfferIds: [],
    });

    expect(mockCreateStockMovement).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 12,
        quantity: 4,
      }),
    );
    expect(mockEnqueueOffersStockSync).toHaveBeenCalledWith(
      {
        sellerIdentifier: 'acct-1',
        itemCode: 'B:PHONE:001:1',
        direction: 'OUT',
      },
      {
        deduplicationKey: 'movement:299',
      },
    );
  });
});
