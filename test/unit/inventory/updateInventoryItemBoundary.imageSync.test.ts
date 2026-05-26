import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ItemKind } from '@/lib/prismaInventoryTypes';
import type { AuthUserType } from '@/types/userType';

const mockPrismaInventory = {
  item: {
    findUnique: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockCalculateRemainingQuantity = jest.fn();
const mockEnqueueOffersImageSync = jest.fn();
const mockBlobKeyToCDNUrl = jest.fn((key: string) => `https://cdn.dev.cellifi.com/${key}`);

jest.mock('@/lib/prismaInventory', () => ({
  __esModule: true,
  default: mockPrismaInventory,
}));

jest.mock('@/services/stockService', () => ({
  calculateRemainingQuantity: (...args: unknown[]) =>
    mockCalculateRemainingQuantity(...args),
}));

jest.mock('@/services/offersStockSyncQueue', () => ({
  enqueueOffersStockSync: jest.fn(),
  enqueueOffersImageSync: (...args: unknown[]) =>
    mockEnqueueOffersImageSync(...args),
}));

jest.mock('@/inventory/services/personalFallbackCodeService', () => ({
  consumePersonalInventoryFallbackCode: jest.fn(),
}));

jest.mock('@/services/blobService/getCDNUrl', () => ({
  blobKeyToCDNUrl: (key: string) => mockBlobKeyToCDNUrl(key),
}));

jest.mock('@/lib/objectStorage', () => ({
  buildRawObjectUrl: jest.fn(),
  extractObjectKeyAccountIdentifier: (key: string) => key.split('/')[1] || '',
}));

jest.mock('@/services/userService', () => ({
  getUserInventoryAddress: jest.fn(),
}));

import { updateInventoryItemBoundary } from '@/inventory/services/inventoryItemService';

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

const createAttachment = (
  id: number,
  checksum: string,
  key = `products/acct-1/image/${checksum}.jpeg`,
  name = `${checksum}-original.png`,
) => ({
  id,
  blob: {
    id: id + 1000,
    checksum,
    key,
    name,
    size: 100 + id,
    fileType: 'image',
    extension: 'jpeg',
    assetRef: `inventory/items/acct-1/listing-photo/ph_${id}`,
  },
});

const createBoundaryItem = (overrides: Record<string, unknown> = {}) => ({
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
  ...overrides,
});

describe('updateInventoryItemBoundary image sync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCalculateRemainingQuantity.mockResolvedValue(4);
    mockEnqueueOffersImageSync.mockResolvedValue({ MessageId: 'image-sync-1' });
  });

  it('enqueues IMAGES_UPDATED when photos change using committed image state', async () => {
    const initialItem = createBoundaryItem();
    const committedMainPhoto = createAttachment(81, 'committed-main');
    const committedSecondaryPhoto = createAttachment(82, 'committed-secondary');
    const committedItem = createBoundaryItem({
      mainImage: committedMainPhoto,
      images: [committedMainPhoto, committedSecondaryPhoto],
    });

    const tx = {
      attachment: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue({ id: 901 }),
      },
      blob: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 900,
            checksum: 'request-photo',
            assetRef: 'inventory/items/acct-1/listing-photo/ph_request',
          },
        ]),
      },
      item: {
        update: jest.fn().mockResolvedValue({}),
        findUniqueOrThrow: jest.fn().mockResolvedValue(committedItem),
      },
    };

    mockPrismaInventory.item.findUnique.mockResolvedValue(initialItem);
    mockPrismaInventory.$transaction.mockImplementation(async (callback: any) =>
      callback(tx),
    );

    const result = await updateInventoryItemBoundary(user, 12, {
      photos: [
        {
          checksum: 'request-photo',
          assetRef: 'inventory/items/acct-1/listing-photo/ph_request',
          key: 'products/acct-1/image/request-photo.jpeg',
          name: 'request-photo-original.png',
          mimeType: 'image/jpeg',
          size: 321,
        },
      ],
    });

    expect(mockEnqueueOffersImageSync).toHaveBeenCalledWith(
      {
        eventType: 'IMAGES_UPDATED',
        sellerIdentifier: 'acct-1',
        itemCode: 'B:PHONE:001:1',
        mainPhoto: {
          blobId: 1081,
          checksum: 'committed-main',
          key: 'products/acct-1/image/committed-main.jpeg',
          name: 'committed-main-original.png',
          mimeType: 'image/jpeg',
          size: 181,
          assetRef: 'inventory/items/acct-1/listing-photo/ph_81',
          cdnUrl: 'https://cdn.dev.cellifi.com/products/acct-1/image/committed-main.jpeg',
        },
        photos: [
          {
            blobId: 1081,
            checksum: 'committed-main',
            key: 'products/acct-1/image/committed-main.jpeg',
            name: 'committed-main-original.png',
            mimeType: 'image/jpeg',
            size: 181,
            assetRef: 'inventory/items/acct-1/listing-photo/ph_81',
            cdnUrl: 'https://cdn.dev.cellifi.com/products/acct-1/image/committed-main.jpeg',
          },
          {
            blobId: 1082,
            checksum: 'committed-secondary',
            key: 'products/acct-1/image/committed-secondary.jpeg',
            name: 'committed-secondary-original.png',
            mimeType: 'image/jpeg',
            size: 182,
            assetRef:
              'inventory/items/acct-1/listing-photo/ph_82',
            cdnUrl: 'https://cdn.dev.cellifi.com/products/acct-1/image/committed-secondary.jpeg',
          },
        ],
      },
      expect.any(Object),
    );
    expect(result.data.resolvedInventoryItem?.mainPhoto).toEqual(
      expect.objectContaining({
        key: 'products/acct-1/image/committed-main.jpeg',
        name: 'committed-main-original.png',
        assetRef: 'inventory/items/acct-1/listing-photo/ph_81',
        cdnUrl: 'https://cdn.dev.cellifi.com/products/acct-1/image/committed-main.jpeg',
      }),
    );
    expect(result.data.resolvedInventoryItem?.mainPhoto).not.toHaveProperty(
      'previewUrl',
    );
  });

  it('enqueues IMAGES_UPDATED when only mainPhotoHash changes using committed image state', async () => {
    const existingMainPhoto = createAttachment(71, 'existing-main');
    const secondaryPhoto = createAttachment(72, 'secondary-photo');
    const initialItem = createBoundaryItem({
      mainImage: existingMainPhoto,
      images: [existingMainPhoto, secondaryPhoto],
    });
    const committedItem = createBoundaryItem({
      mainImage: secondaryPhoto,
      images: [existingMainPhoto, secondaryPhoto],
    });

    const tx = {
      attachment: {
        findFirst: jest.fn().mockResolvedValue({ id: secondaryPhoto.id }),
      },
      item: {
        update: jest.fn().mockResolvedValue({}),
        findUniqueOrThrow: jest.fn().mockResolvedValue(committedItem),
      },
    };

    mockPrismaInventory.item.findUnique.mockResolvedValue(initialItem);
    mockPrismaInventory.$transaction.mockImplementation(async (callback: any) =>
      callback(tx),
    );

    const result = await updateInventoryItemBoundary(user, 12, {
      mainPhotoHash: 'secondary-photo',
    });

    expect(mockEnqueueOffersImageSync).toHaveBeenCalledWith(
      {
        eventType: 'IMAGES_UPDATED',
        sellerIdentifier: 'acct-1',
        itemCode: 'B:PHONE:001:1',
        mainPhoto: {
          blobId: 1072,
          checksum: 'secondary-photo',
          key: 'products/acct-1/image/secondary-photo.jpeg',
          name: 'secondary-photo-original.png',
          mimeType: 'image/jpeg',
          size: 172,
          assetRef: 'inventory/items/acct-1/listing-photo/ph_72',
          cdnUrl: 'https://cdn.dev.cellifi.com/products/acct-1/image/secondary-photo.jpeg',
        },
        photos: [
          {
            blobId: 1071,
            checksum: 'existing-main',
            key: 'products/acct-1/image/existing-main.jpeg',
            name: 'existing-main-original.png',
            mimeType: 'image/jpeg',
            size: 171,
            assetRef: 'inventory/items/acct-1/listing-photo/ph_71',
            cdnUrl: 'https://cdn.dev.cellifi.com/products/acct-1/image/existing-main.jpeg',
          },
          {
            blobId: 1072,
            checksum: 'secondary-photo',
            key: 'products/acct-1/image/secondary-photo.jpeg',
            name: 'secondary-photo-original.png',
            mimeType: 'image/jpeg',
            size: 172,
            assetRef: 'inventory/items/acct-1/listing-photo/ph_72',
            cdnUrl: 'https://cdn.dev.cellifi.com/products/acct-1/image/secondary-photo.jpeg',
          },
        ],
      },
      expect.any(Object),
    );
    expect(result.data.resolvedInventoryItem?.mainPhoto).toEqual(
      expect.objectContaining({
        key: 'products/acct-1/image/secondary-photo.jpeg',
        name: 'secondary-photo-original.png',
        assetRef: 'inventory/items/acct-1/listing-photo/ph_72',
        cdnUrl: 'https://cdn.dev.cellifi.com/products/acct-1/image/secondary-photo.jpeg',
      }),
    );
    expect(result.data.resolvedInventoryItem?.mainPhoto).not.toHaveProperty(
      'previewUrl',
    );
  });

  it('does not attach or select another seller blob when checksum matches', async () => {
    const initialItem = createBoundaryItem();
    const committedMainPhoto = createAttachment(91, 'shared-checksum');
    const committedItem = createBoundaryItem({
      mainImage: committedMainPhoto,
      images: [committedMainPhoto],
    });

    const tx = {
      attachment: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue({ id: committedMainPhoto.id }),
      },
      blob: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 900,
            checksum: 'shared-checksum',
            key: 'products/acct-1/image/shared-checksum.jpeg',
            assetRef: 'inventory/items/acct-1/listing-photo/ph_shared',
          },
          {
            id: 901,
            checksum: 'shared-checksum',
            key: 'products/acct-2/image/shared-checksum.jpeg',
            assetRef: 'inventory/items/acct-2/listing-photo/ph_shared',
          },
        ]),
      },
      item: {
        update: jest.fn().mockResolvedValue({}),
        findUniqueOrThrow: jest.fn().mockResolvedValue(committedItem),
      },
    };

    mockPrismaInventory.item.findUnique.mockResolvedValue(initialItem);
    mockPrismaInventory.$transaction.mockImplementation(async (callback: any) =>
      callback(tx),
    );

    await updateInventoryItemBoundary(user, 12, {
      photos: [
        {
          checksum: 'shared-checksum',
          assetRef: 'inventory/items/acct-1/listing-photo/ph_shared',
          key: 'products/acct-1/image/shared-checksum.jpeg',
          name: 'shared-checksum-original.png',
          mimeType: 'image/jpeg',
          size: 321,
        },
      ],
      mainPhotoHash: 'shared-checksum',
    });

    expect(tx.attachment.createMany).toHaveBeenCalledWith({
      data: [
        {
          attachmentType: 'IMAGE',
          blobId: 900,
          attachableId: 12,
          attachableType: 'InventoryItem',
        },
      ],
      skipDuplicates: true,
    });
    expect(tx.attachment.findFirst).toHaveBeenCalledWith({
      where: {
        blobId: 900,
        attachableId: 12,
        attachableType: 'InventoryItem',
        attachmentType: 'IMAGE',
      },
    });
  });

  it('clears the main image when photos are explicitly emptied even if the request still carries a stale mainPhotoHash', async () => {
    const existingMainPhoto = createAttachment(61, 'existing-main');
    const initialItem = createBoundaryItem({
      mainImage: existingMainPhoto,
      images: [existingMainPhoto],
    });
    const committedItem = createBoundaryItem({
      mainImage: null,
      images: [],
    });

    const tx = {
      attachment: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: existingMainPhoto.id,
            blob: existingMainPhoto.blob,
          },
        ]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        findFirst: jest.fn(),
      },
      item: {
        findUnique: jest.fn().mockResolvedValue({ mainImageId: existingMainPhoto.id }),
        update: jest.fn().mockResolvedValue({}),
        findUniqueOrThrow: jest.fn().mockResolvedValue(committedItem),
      },
      blob: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    mockPrismaInventory.item.findUnique.mockResolvedValue(initialItem);
    mockPrismaInventory.$transaction.mockImplementation(async (callback: any) =>
      callback(tx),
    );

    const result = await updateInventoryItemBoundary(user, 12, {
      photos: [],
      mainPhotoHash: 'stale-photo-checksum',
    });

    expect(tx.attachment.deleteMany).toHaveBeenCalledWith({
      where: {
        id: {
          in: [existingMainPhoto.id],
        },
      },
    });
    expect(tx.attachment.createMany).not.toHaveBeenCalled();
    expect(tx.attachment.findFirst).not.toHaveBeenCalled();
    expect(result.data.resolvedInventoryItem?.mainPhoto).toBeNull();
    expect(result.data.resolvedInventoryItem?.photos).toEqual([]);
  });
});
