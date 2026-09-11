import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockPrismaInventory = {
  item: {
    count: jest.fn<(_args: unknown) => Promise<number>>(),
    findMany: jest.fn<(_args: unknown) => Promise<never[]>>(),
  },
  movement: {
    groupBy: jest.fn<(_args: unknown) => Promise<never[]>>(),
  },
};

jest.mock('@/lib/prismaInventory', () => ({
  __esModule: true,
  default: mockPrismaInventory,
}));

import { getInventoryItems } from '@/inventory/services/itemListingService';
import type { AuthUserType } from '@/types/userType';

describe('getInventoryItems code filtering', () => {
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
    mockPrismaInventory.item.count.mockResolvedValue(0);
    mockPrismaInventory.item.findMany.mockResolvedValue([]);
    mockPrismaInventory.movement.groupBy.mockResolvedValue([]);
  });

  it('constrains inventory list reads by code for the authenticated seller', async () => {
    await getInventoryItems(
      [{ code: ['B:PHONE:001:1', 'B:PHONE:002:1'] }],
      { page: 1, perPage: 20 },
      undefined,
      user
    );

    expect(mockPrismaInventory.item.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sellerIdentifier: 'acct-1',
          deletedAt: null,
          itemCode: {
            in: ['B:PHONE:001:1', 'B:PHONE:002:1'],
          },
        }),
      })
    );
  });
});
