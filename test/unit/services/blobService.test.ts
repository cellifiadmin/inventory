import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { INVENTORY_LISTING_PHOTO_USAGE } from '@/lib/objectStorage';
import type { AuthUserType } from '@/types/userType';

const mockPrismaInventory = {
  blob: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
  },
};

jest.mock('@/lib/prismaInventory', () => ({
  __esModule: true,
  default: mockPrismaInventory,
}));

jest.mock('@/lib/objectStorage', () => ({
  INVENTORY_LISTING_PHOTO_USAGE: 'inventory-listing-photo',
  buildRawObjectUrl: jest.fn((_bucket: string, key: string) => `s3://cellifi-local/${key}`),
  createObjectStorageS3: jest.fn(() => ({
    getSignedUrl: jest.fn(),
  })),
}));

import { createBlob } from '@/services/blobService';

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

describe('blobService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates a new logical blob row when the physical media key already exists under a different assetRef', async () => {
    mockPrismaInventory.blob.findUnique.mockImplementation(
      async ({ where }: { where: { key?: string; assetRef?: string } }) => {
        if (where.key) {
          return {
            id: 11,
            key: where.key,
            checksum: 'same-checksum',
            assetRef: 'inventory/items/acct-1/listing-photo/ph_existing',
          };
        }

        return null;
      },
    );
    mockPrismaInventory.blob.create.mockResolvedValue({
      id: 12,
      key: 'media/image/same-checksum/inventory-listing-photo-v1.jpeg',
      checksum: 'same-checksum',
      assetRef: 'inventory/items/acct-1/listing-photo/ph_new',
    });

    const result = await createBlob(user, {
      usage: INVENTORY_LISTING_PHOTO_USAGE,
      key: 'media/image/same-checksum/inventory-listing-photo-v1.jpeg',
      checksum: 'same-checksum',
      assetRef: 'inventory/items/acct-1/listing-photo/ph_new',
      mimeType: 'image/jpeg',
      size: 1234,
      name: 'photo.jpg',
    });

    expect(mockPrismaInventory.blob.findUnique).toHaveBeenCalledWith({
      where: {
        assetRef: 'inventory/items/acct-1/listing-photo/ph_new',
      },
    });
    expect(mockPrismaInventory.blob.create).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        id: 12,
        key: 'media/image/same-checksum/inventory-listing-photo-v1.jpeg',
        assetRef: 'inventory/items/acct-1/listing-photo/ph_new',
      }),
    );
  });
});
