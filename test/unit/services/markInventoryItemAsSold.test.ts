import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockPrismaInventory = {
  $queryRaw: jest.fn(async () => [{ id: 12 }]),
  $transaction: jest.fn<(callback: (tx: unknown) => Promise<unknown>) => Promise<unknown>>(),
  movement: { findMany: jest.fn(async () => [{ quantity: await mockCalculateRemainingQuantity(), direction: 'IN' }]) },
  item: {
    findUnique: jest.fn<() => Promise<{ id: number; itemCode: string; sellerIdentifier: string; deletedAt: Date | null } | null>>(),
  },
};

const mockCalculateRemainingQuantity = jest.fn<(...args: unknown[]) => Promise<number>>();
const mockCreateStockMovement = jest.fn<(...args: unknown[]) => Promise<{ id: number }>>();
const mockEnqueueOffersStockSync = jest.fn<(...args: unknown[]) => Promise<{ MessageId: string }>>();

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
    mockPrismaInventory.$transaction.mockImplementation(callback => callback(mockPrismaInventory));
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
      mockPrismaInventory,
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
      mockPrismaInventory,
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
  it.each([0, -1, 1.5])('rejects invalid sold quantity %p', async quantity => {
    await expect(markInventoryItemAsSold(user, 12, quantity)).rejects.toThrow('Invalid quantity');
    expect(mockPrismaInventory.$transaction).not.toHaveBeenCalled();
  });
  it('requires seller identity before locking stock', async () => {
    await expect(markInventoryItemAsSold({ ...user, accountIdentifier: undefined }, 12)).rejects.toThrow('Seller required');
  });
  it.each([null, { id: 12, itemCode: 'code', sellerIdentifier: 'acct-1', deletedAt: new Date() }])('rejects missing or deleted stock %p', async item => {
    mockPrismaInventory.item.findUnique.mockResolvedValue(item);
    await expect(markInventoryItemAsSold(user, 12)).rejects.toThrow('Inventory item not found');
  });
  it('enforces seller ownership within the transaction', async () => {
    mockPrismaInventory.item.findUnique.mockResolvedValue({ id: 12, itemCode: 'code', sellerIdentifier: 'other', deletedAt: null });
    await expect(markInventoryItemAsSold(user, 12)).rejects.toThrow('Inventory item seller invalid');
  });
  it.each([[0, undefined, 'No remaining quantity available'], [1, 2, 'Insufficient stock. Remaining: 1, requested: 2']] as const)('validates the locked balance %p', async (balance, quantity, message) => {
    mockPrismaInventory.item.findUnique.mockResolvedValue({ id: 12, itemCode: 'code', sellerIdentifier: 'acct-1', deletedAt: null });
    mockCalculateRemainingQuantity.mockResolvedValue(balance);
    await expect(markInventoryItemAsSold(user, 12, quantity)).rejects.toThrow(message);
    expect(mockCreateStockMovement).not.toHaveBeenCalled();
  });

});
