import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ItemKind } from '@/lib/prismaInventoryTypes';
import type { AuthUserType } from '@/types/userType';

const mockPrismaInventory: any = {
  offersOffer: {
    findUnique: jest.fn(),
  },
  item: {
    findUnique: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockNotifyOffersOnImageUpdate: any = jest.fn();
const mockCalculateRemainingQuantity: any = jest.fn();
const mockTouchPublishedOffer: any = jest.fn();
const mockDelistMirroredOffer: any = jest.fn();

jest.mock('@/lib/prismaInventory', () => ({
  __esModule: true,
  default: mockPrismaInventory,
}));

jest.mock('@/inventory/services/notifyOffersOnImageUpdate', () => ({
  notifyOffersOnImageUpdate: (...args: unknown[]) =>
    mockNotifyOffersOnImageUpdate(...args),
}));

jest.mock('@/services/stockService', () => ({
  calculateRemainingQuantity: (...args: unknown[]) =>
    mockCalculateRemainingQuantity(...args),
}));

jest.mock('@/inventory/services/offerMirrorService', () => ({
  buildOfferBackedRegion: jest.fn(),
  delistMirroredOffer: (...args: unknown[]) => mockDelistMirroredOffer(...args),
  getOfferReadStatus: jest.fn(),
  touchPublishedOffer: (...args: unknown[]) => mockTouchPublishedOffer(...args),
}));

jest.mock('@/services/blobService', () => ({
  generatePreviewUrl: jest.fn(),
}));

jest.mock('@/lib/objectStorage', () => ({
  buildRawObjectUrl: jest.fn(),
}));

import { updateInventoryItemListing } from '@/inventory/services/itemListingService';

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
  blobId: id + 1000,
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

const createItem = (overrides: Record<string, unknown> = {}) => ({
  id: 44,
  kind: ItemKind.LISTING,
  itemCode: 'B:PHONE:001:1',
  sellerIdentifier: 'acct-1',
  deletedAt: null,
  mainImageId: null,
  mainImage: null,
  images: [],
  components: [],
  ...overrides,
});

const createOffer = (overrides: Record<string, unknown> = {}) => ({
  id: 4,
  sellerIdentifier: 'acct-1',
  itemCode: 'B:PHONE:001:1',
  deletedAt: null,
  expiredAt: null,
  validFrom: null,
  validTo: null,
  description: 'existing description',
  currentPrice: null,
  currentPriceId: null,
  status: 'ACTIVE',
  latestPublication: {
    id: 991,
  },
  prices: [],
  visits: [],
  ...overrides,
});

const resolvedMock = (value: unknown) => {
  const mock: any = jest.fn();
  mock.mockResolvedValue(value);
  return mock;
};

describe('updateInventoryItemListing image sync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCalculateRemainingQuantity.mockResolvedValue(1);
    mockTouchPublishedOffer.mockResolvedValue({ id: 4 });
    mockDelistMirroredOffer.mockResolvedValue(null);
  });

  it('emits IMAGES_UPDATED when photos change through the legacy listing update path', async () => {
    const initialItem = createItem();
    const committedMainPhoto = createAttachment(81, 'committed-main');
    const committedSecondaryPhoto = createAttachment(82, 'committed-secondary');
    const committedItem = createItem({
      mainImageId: committedMainPhoto.id,
      mainImage: committedMainPhoto,
      images: [committedMainPhoto, committedSecondaryPhoto],
    });

    mockPrismaInventory.offersOffer.findUnique
      .mockResolvedValueOnce(createOffer())
      .mockResolvedValueOnce(createOffer());
    mockPrismaInventory.item.findUnique
      .mockResolvedValueOnce(initialItem)
      .mockResolvedValueOnce(committedItem);

    const tx: any = {
      offersOffer: {
        update: resolvedMock({}),
      },
      attachment: {
        findMany: resolvedMock([]),
        upsert: resolvedMock({}),
      },
      blob: {
        findMany: resolvedMock([
          {
            id: 900,
            checksum: 'request-photo',
            assetRef: 'inventory/items/acct-1/listing-photo/ph_request',
          },
        ]),
      },
      item: {
        update: resolvedMock({}),
      },
      movement: {
        findMany: resolvedMock([]),
      },
    };

    mockPrismaInventory.$transaction.mockImplementation(async (callback: any) =>
      callback(tx),
    );

    await updateInventoryItemListing({
      id: 4,
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
      user,
    });

    expect(mockNotifyOffersOnImageUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        mainImage: expect.objectContaining({
          blob: expect.objectContaining({
            key: 'products/acct-1/image/committed-main.jpeg',
            assetRef: 'inventory/items/acct-1/listing-photo/ph_81',
          }),
        }),
      }),
    );
  });

  it('emits IMAGES_UPDATED when only mainPhotoHash changes through the legacy listing update path', async () => {
    const existingMainPhoto = createAttachment(71, 'existing-main');
    const secondaryPhoto = createAttachment(72, 'secondary-photo');
    const initialItem = createItem({
      mainImageId: existingMainPhoto.id,
      mainImage: existingMainPhoto,
      images: [existingMainPhoto, secondaryPhoto],
    });
    const committedItem = createItem({
      mainImageId: secondaryPhoto.id,
      mainImage: secondaryPhoto,
      images: [existingMainPhoto, secondaryPhoto],
    });

    mockPrismaInventory.offersOffer.findUnique
      .mockResolvedValueOnce(createOffer())
      .mockResolvedValueOnce(createOffer());
    mockPrismaInventory.item.findUnique
      .mockResolvedValueOnce(initialItem)
      .mockResolvedValueOnce(committedItem);

    const tx: any = {
      offersOffer: {
        update: resolvedMock({}),
      },
      attachment: {
        findFirst: resolvedMock({ id: secondaryPhoto.id }),
      },
      blob: {
        findFirst: resolvedMock({ id: secondaryPhoto.blob.id }),
      },
      item: {
        update: resolvedMock({}),
      },
      movement: {
        findMany: resolvedMock([]),
      },
    };

    mockPrismaInventory.$transaction.mockImplementation(async (callback: any) =>
      callback(tx),
    );

    await updateInventoryItemListing({
      id: 4,
      mainPhotoHash: 'secondary-photo',
      user,
    });

    expect(mockNotifyOffersOnImageUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        mainImage: expect.objectContaining({
          blob: expect.objectContaining({
            key: 'products/acct-1/image/secondary-photo.jpeg',
            assetRef:
              'inventory/items/acct-1/listing-photo/ph_72',
          }),
        }),
      }),
    );
  });

  it('does not emit IMAGES_UPDATED when the legacy listing update path changes no image fields', async () => {
    const initialItem = createItem();

    mockPrismaInventory.offersOffer.findUnique
      .mockResolvedValueOnce(createOffer())
      .mockResolvedValueOnce(createOffer());
    mockPrismaInventory.item.findUnique.mockResolvedValueOnce(initialItem);

    const tx: any = {
      offersOffer: {
        update: resolvedMock({}),
      },
      movement: {
        findMany: resolvedMock([]),
      },
    };

    mockPrismaInventory.$transaction.mockImplementation(async (callback: any) =>
      callback(tx),
    );

    await updateInventoryItemListing({
      id: 4,
      description: 'updated description',
      user,
    });

    expect(mockNotifyOffersOnImageUpdate).not.toHaveBeenCalled();
  });
});
