import {
  ComponentChildType,
  ItemKind,
  MovementDirection,
  MovementReason,
  Prisma as InventoryPrisma,
} from '@/lib/prismaInventoryTypes';
import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';
import { inventoryPhotoSchema } from '@/inventory/validation/validateCreateInventoryItemInput';

import {
  buildOfferBackedRegion,
  delistMirroredOffer,
  getOfferReadStatus,
  touchPublishedOffer,
} from '@/inventory/services/offerMirrorService';
import {
  resolveInventoryPhotoBlobs,
  type InventoryPhotoInput,
} from '@/inventory/services/itemImageService';
import { notifyOffersOnImageUpdate } from '@/inventory/services/notifyOffersOnImageUpdate';
import prismaInventory from '@/lib/prismaInventory';
import { generatePreviewUrl } from '@/services/blobService';
import { blobKeyToCDNUrl } from '@/services/blobService/getCDNUrl';
import {
  calculateRemainingQuantity,
} from '@/services/stockService';
import { getPaginationQueryParams } from '@/services/paginationService';
import type { PaginationInputType } from '@/types/pagination';
import type { AuthUserType } from '@/types/userType';
import { doPeriodsOverlap } from '@/utils/dateUtils';

const itemListingInclude = {
  components: {
    orderBy: {
      position: 'asc',
    },
    include: {
      instance: true,
      bundle: true,
    },
  },
  mainImage: {
    include: {
      blob: true,
    },
  },
  images: {
    where: {
      attachableType: 'InventoryItem',
      attachmentType: 'IMAGE',
      deletedAt: null,
    },
    include: {
      blob: true,
    },
    orderBy: {
      id: 'asc',
    },
  },
} as const;

type BoundaryItem = InventoryPrisma.ItemGetPayload<{
  include: typeof itemListingInclude;
}>;

type OfferBoundary = InventoryPrisma.OffersOfferGetPayload<{
  include: {
    currentPrice: true;
    latestPublication: true;
    prices: {
      orderBy: {
        createdAt: 'desc';
      };
    };
    visits: true;
  };
}>;

type OfferBrowseBoundary = OfferBoundary;

const updateInventoryItemSchema = z
  .object({
    price: z.coerce.number().min(0, 'Price must be greater than or equal to 0').optional(),
    quantity: z.coerce
      .number()
      .int()
      .min(0, 'Available units for sale must be greater than or equal to 0')
      .optional(),
    availableFrom: z.string().min(1, 'Invalid start date').optional(),
    availableTo: z.string().min(1, 'Invalid end date').nullable().optional(),
    description: z.string().nullable().optional(),
    mainPhotoHash: z.string().nullable().optional(),
    photos: z.array(inventoryPhotoSchema).optional(),
  })
  .refine(
    (data) => {
      if (data.availableFrom && data.availableTo) {
        const availableFromDate = new Date(data.availableFrom);
        const availableToDate = new Date(data.availableTo);

        if (availableToDate <= availableFromDate) {
          return false;
        }
      }
      return true;
    },
    {
      message: 'Available to date must be greater than available from date',
      path: ['availableTo'],
    },
  );

type UpdateInventoryItemPayload = z.infer<typeof updateInventoryItemSchema>;

interface UpdateInventoryItemInput extends UpdateInventoryItemPayload {
  id: number;
  user: AuthUserType;
}

export const validateInventoryItemUpdatePayload = (payload: unknown) => {
  const result = updateInventoryItemSchema.safeParse(payload ?? {});

  if (!result.success) {
    throw createError(StatusCodes.BAD_REQUEST, result.error.message);
  }

  return result.data;
};

const getProductSnapshot = (componentSnapshot: unknown) => {
  if (!componentSnapshot || typeof componentSnapshot !== 'object') {
    return null;
  }

  const snapshotContainer = componentSnapshot as {
    productSnapshot?: Record<string, unknown>;
  };

  return snapshotContainer.productSnapshot ?? null;
};

const buildComponentReadView = (
  item: Pick<BoundaryItem, 'id' | 'kind'>,
  component: BoundaryItem['components'][number],
) => {
  const productSnapshot = getProductSnapshot(component.componentSnapshot);

  if (component.childType === ComponentChildType.INSTANCE && component.instance) {
    return {
      id: component.id,
      itemId: component.itemId,
      sku: component.instance.sku,
      productType: component.instance.productType,
      count: 1,
      quantity: 1,
      productSnapshot,
      product: productSnapshot,
      kind: item.kind,
      identifier: component.instance.identifier,
      imei: component.instance.identifier,
    };
  }

  if (component.childType === ComponentChildType.BUNDLE && component.bundle) {
    return {
      id: component.id,
      itemId: component.itemId,
      sku: component.bundle.sku,
      productType: component.bundle.productType,
      count: component.bundle.count,
      quantity: component.bundle.count,
      productSnapshot,
      product: productSnapshot,
    };
  }

  throw createError(StatusCodes.INTERNAL_SERVER_ERROR, 'Component leaf missing');
};

const buildInventoryItemReadView = (
  item: BoundaryItem,
  offer: Pick<OfferBoundary, 'addressState' | 'addressCountry'>,
) => ({
  id: item.id,
  kind: item.kind,
  status: item.status,
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
  deletedAt: item.deletedAt,
  mainImageId: item.mainImageId,
  sellerIdentifier: item.sellerIdentifier,
  code: item.itemCode,
  region: buildOfferBackedRegion(offer),
  components: item.components.map((component) => buildComponentReadView(item, component)),
  mainImage: item.mainImage,
  images: item.images,
});

const buildManageInventoryItemReadView = (
  item: BoundaryItem,
) => ({
  id: item.id,
  kind: item.kind,
  status: item.status,
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
  deletedAt: item.deletedAt,
  mainImageId: item.mainImageId,
  sellerIdentifier: item.sellerIdentifier,
  code: item.itemCode,
  components: item.components.map((component) =>
    buildComponentReadView(item, component),
  ),
  mainImage: item.mainImage,
});

const createEmptyInventoryMovementAggregation = (): InventoryMovementAggregation => ({
  availableUnits: 0,
  totalInboundUnits: 0,
  totalOutboundUnits: 0,
  soldUnits: 0,
});

const buildManageInventoryItemMainImageReadView = async (
  mainImage: BoundaryItem['mainImage'],
) => {
  if (!mainImage) {
    return null;
  }

  return {
    ...mainImage,
    previewUrl: await generatePreviewUrl(mainImage.blob),
  };
};

const buildManageInventoryItemListReadView = async (
  item: BoundaryItem,
  aggregation: InventoryMovementAggregation,
) => ({
  ...buildManageInventoryItemReadView(item),
  addressLine1: item.addressLine1,
  addressLine2: item.addressLine2,
  addressCity: item.addressCity,
  addressStateCode: item.addressStateCode,
  addressPostalCode: item.addressPostalCode,
  addressCountryCode: item.addressCountryCode,
  addressLatitude: item.addressLatitude,
  addressLongitude: item.addressLongitude,
  mainImage: await buildManageInventoryItemMainImageReadView(item.mainImage),
  aggregation,
});

const getItemByBoundary = async (
  sellerIdentifier: string | null | undefined,
  itemCode: string | null | undefined,
) => {
  if (!sellerIdentifier || !itemCode) {
    return null;
  }

  return prismaInventory.item.findUnique({
    where: {
      sellerIdentifier_itemCode: {
        sellerIdentifier,
        itemCode,
      },
    },
    include: itemListingInclude,
  });
};

const getOwnedInventoryItemById = async (id: number, user?: AuthUserType) => {
  const item = await prismaInventory.item.findUnique({
    where: { id },
    include: itemListingInclude,
  });

  if (!item) {
    throw createError(StatusCodes.NOT_FOUND, 'Inventory item not found');
  }

  if (user && item.sellerIdentifier !== user.accountIdentifier) {
    throw createError(
      StatusCodes.FORBIDDEN,
      'Not authorized to access this inventory item'
    );
  }

  return item;
};

// The current `/manage/listings/[id]` route is backed by the latest undeleted offer id.
export const findExistingManageListingViewId = async (
  sellerIdentifier: string,
  itemCode: string,
) => {
  const listingView = await prismaInventory.offersOffer.findFirst({
    where: {
      sellerIdentifier,
      itemCode,
      deletedAt: null,
    },
    orderBy: {
      id: 'desc',
    },
    select: {
      id: true,
    },
  });

  return listingView?.id ?? null;
};

const getOfferBoundaryById = async (id: number) =>
  prismaInventory.offersOffer.findUnique({
    where: { id },
    include: {
      currentPrice: true,
      latestPublication: true,
      prices: {
        orderBy: {
          createdAt: 'desc',
        },
      },
      visits: true,
    },
  });

const getOfferWithItemById = async (id: number, user?: AuthUserType) => {
  const offer = await getOfferBoundaryById(id);

  if (!offer || offer.deletedAt) {
    throw createError(StatusCodes.NOT_FOUND, 'Listing not found');
  }

  const item = await getItemByBoundary(offer.sellerIdentifier, offer.itemCode);

  if (!item) {
    throw createError(StatusCodes.NOT_FOUND, 'Listing not found');
  }

  if (user && item.sellerIdentifier !== user.accountIdentifier) {
    throw createError(StatusCodes.FORBIDDEN, 'Not authorized to access this listing');
  }

  return { offer, item };
};

const getImageChecksum = (
  attachment: BoundaryItem['mainImage'] | BoundaryItem['images'][number] | null | undefined,
) => attachment?.blob?.checksum ?? null;

const getImageChecksums = (attachments: BoundaryItem['images']) =>
  attachments.map((attachment) => attachment.blob.checksum);

const imageChecksumsMatch = (left: string[], right: string[]) =>
  left.length === right.length &&
  left.every((checksum, index) => checksum === right[index]);

const imageStateChanged = (
  previousItem: Pick<BoundaryItem, 'mainImage' | 'images'>,
  committedItem: Pick<BoundaryItem, 'mainImage' | 'images'>,
) =>
  getImageChecksum(previousItem.mainImage) !== getImageChecksum(committedItem.mainImage) ||
  !imageChecksumsMatch(
    getImageChecksums(previousItem.images),
    getImageChecksums(committedItem.images),
  );

const buildCurrentPriceReadView = (
  offer: Pick<OfferBoundary, 'currentPrice' | 'currencySymbol' | 'currencyCode'>,
) =>
  offer.currentPrice
    ? {
        ...offer.currentPrice,
        currency: offer.currencySymbol || '$',
        currencyCode: offer.currencyCode || 'USD',
      }
    : null;

const buildListingView = async (offer: OfferBoundary, item: BoundaryItem) => ({
  ...offer,
  inventoryItem: buildInventoryItemReadView(item, offer),
  status: getOfferReadStatus(offer),
  totalStock: await calculateRemainingQuantity(item.id),
  currentPrice: buildCurrentPriceReadView(offer),
});

const getComparableValues = (
  value: unknown,
): string[] =>
  value == null
    ? []
    : [String(value), String(value).toLowerCase()];

const matchesAnyComparableValue = (candidate: unknown, expected: string) => {
  const normalizedExpected = expected.toLowerCase();
  return getComparableValues(candidate).some((value) => value.toLowerCase() === normalizedExpected);
};

const getRecordComponents = (record: any): Array<Record<string, any>> =>
  Array.isArray(record.inventoryItem?.components) ? record.inventoryItem.components : [];

const getPrimaryComponent = (record: any) => getRecordComponents(record)[0] ?? null;

const getPrimaryProductSnapshot = (record: any) => getPrimaryComponent(record)?.productSnapshot ?? null;

const getOfferStatus = (offer: Pick<OfferBoundary, 'expiredAt' | 'status' | 'version'>) =>
  getOfferReadStatus(offer);

const getSearchableComponentValues = (component: Record<string, any>) => {
  const productSnapshot = component.productSnapshot ?? {};

  return [
    productSnapshot?.brand?.name,
    productSnapshot?.model?.name,
    productSnapshot?.color?.name,
    productSnapshot?.storage?.name,
    productSnapshot?.carrier?.name,
    productSnapshot?.condition?.label,
    component.identifier,
    component.imei,
  ]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.toLowerCase());
};

const matchesRecordFilter = (record: any, filter: Record<string, any>) => {
  const components = getRecordComponents(record);
  const primarySnapshot = getPrimaryProductSnapshot(record);

  return Object.entries(filter).every(([key, value]) => {
    if (value == null) {
      return true;
    }

    if (key === 'search') {
      const terms = Array.isArray(value) ? value : [value];
      return terms.every((term) => {
        if (typeof term !== 'string') {
          return true;
        }

        const normalizedTerm = term.trim().toLowerCase();
        if (!normalizedTerm) {
          return true;
        }

        return components.some((component) =>
          getSearchableComponentValues(component).some((candidate) =>
            candidate.includes(normalizedTerm),
          ),
        );
      });
    }

    if (key === 'status') {
      const statuses = Array.isArray(value) ? value : [value];
      return statuses.some(
        (status) => typeof status === 'string' && getOfferStatus(record) === status.toUpperCase(),
      );
    }

    if (key === 'expired') {
      const expectedExpired = value === true || value === 'true';
      return expectedExpired ? record.expiredAt != null : record.expiredAt == null;
    }

    if (key === 'price') {
      const amount = Number(record.currentPrice?.amount ?? 0);
      return (
        (value.min === undefined || amount >= Number(value.min)) &&
        (value.max === undefined || amount <= Number(value.max))
      );
    }

    if (key === 'quantity') {
      const quantity = Number(record.totalStock ?? 0);
      return (
        (value.min === undefined || quantity >= Number(value.min)) &&
        (value.max === undefined || quantity <= Number(value.max))
      );
    }

    if (key === 'battery') {
      const batteryValues = components
        .map((component) => component.productSnapshot?.batteryLevel)
        .filter((batteryLevel): batteryLevel is number => typeof batteryLevel === 'number');

      if (batteryValues.length === 0) {
        return false;
      }

      return batteryValues.some(
        (batteryLevel) =>
          (value.min === undefined || batteryLevel >= Number(value.min)) &&
          (value.max === undefined || batteryLevel <= Number(value.max)),
      );
    }

    const expectedValues = Array.isArray(value) ? value : [value];

    if (key === 'brand') {
      return components.some((component) =>
        expectedValues.some((expected) =>
          typeof expected === 'string' &&
          (matchesAnyComparableValue(component.productSnapshot?.brand?.key, expected) ||
            matchesAnyComparableValue(component.productSnapshot?.brand?.name, expected)),
        ),
      );
    }

    if (key === 'model') {
      return components.some((component) =>
        expectedValues.some((expected) =>
          typeof expected === 'string' &&
          (matchesAnyComparableValue(component.productSnapshot?.model?.key, expected) ||
            matchesAnyComparableValue(component.productSnapshot?.model?.name, expected)),
        ),
      );
    }

    if (key === 'color') {
      return components.some((component) =>
        expectedValues.some(
          (expected) =>
            typeof expected === 'string' &&
            (matchesAnyComparableValue(component.productSnapshot?.color?.key, expected) ||
              matchesAnyComparableValue(component.productSnapshot?.color?.name, expected)),
        ),
      );
    }

    if (key === 'storage') {
      return components.some((component) =>
        expectedValues.some(
          (expected) =>
            typeof expected === 'string' &&
            (matchesAnyComparableValue(component.productSnapshot?.storage?.key, expected) ||
              matchesAnyComparableValue(component.productSnapshot?.storage?.name, expected)),
        ),
      );
    }

    if (key === 'carrier') {
      return components.some((component) =>
        expectedValues.some(
          (expected) =>
            typeof expected === 'string' &&
            (matchesAnyComparableValue(component.productSnapshot?.carrier?.key, expected) ||
              matchesAnyComparableValue(component.productSnapshot?.carrier?.name, expected)),
        ),
      );
    }

    if (key === 'condition') {
      return components.some((component) =>
        expectedValues.some(
          (expected) =>
            typeof expected === 'string' &&
            (matchesAnyComparableValue(component.productSnapshot?.condition?.key, expected) ||
              matchesAnyComparableValue(component.productSnapshot?.condition?.label, expected)),
        ),
      );
    }

    if (key === 'region' || key === 'addressState') {
      return expectedValues.some(
        (expected) =>
          typeof expected === 'string' &&
          matchesAnyComparableValue(record.addressState ?? record.regionCode, expected),
      );
    }

    if (key === 'country' || key === 'addressCountry') {
      return expectedValues.some(
        (expected) =>
          typeof expected === 'string' &&
          matchesAnyComparableValue(record.addressCountry ?? record.countryCode, expected),
      );
    }

    if (key === 'currency') {
      return expectedValues.some(
        (expected) =>
          typeof expected === 'string' &&
          matchesAnyComparableValue(record.currencyCode, expected),
      );
    }

    return expectedValues.some(
      (expected) =>
        typeof expected === 'string' &&
        (matchesAnyComparableValue(primarySnapshot?.[key]?.key, expected) ||
          matchesAnyComparableValue(primarySnapshot?.[key]?.name, expected) ||
          matchesAnyComparableValue(primarySnapshot?.[key], expected) ||
          matchesAnyComparableValue(record[key], expected)),
    );
  });
};

const getSortValue = (record: any, key: string) => {
  const primarySnapshot = getPrimaryProductSnapshot(record);

  switch (key) {
    case 'status':
      return getOfferStatus(record);
    case 'price':
      return Number(record.currentPrice?.amount ?? 0);
    case 'battery': {
      const batteryLevels = getRecordComponents(record)
        .map((component) => component.productSnapshot?.batteryLevel)
        .filter((batteryLevel): batteryLevel is number => typeof batteryLevel === 'number');
      return batteryLevels.length > 0 ? Math.min(...batteryLevels) : 0;
    }
    case 'quantity':
      return Number(record.totalStock ?? 0);
    case 'brand':
      return primarySnapshot?.brand?.name ?? primarySnapshot?.brand?.key ?? '';
    case 'model':
      return primarySnapshot?.model?.name ?? primarySnapshot?.model?.key ?? '';
    case 'color':
      return primarySnapshot?.color?.name ?? primarySnapshot?.color?.key ?? '';
    case 'storage':
      return primarySnapshot?.storage?.name ?? primarySnapshot?.storage?.key ?? '';
    case 'carrier':
      return primarySnapshot?.carrier?.name ?? primarySnapshot?.carrier?.key ?? '';
    case 'condition':
      return primarySnapshot?.condition?.label ?? primarySnapshot?.condition?.key ?? '';
    case 'region':
    case 'addressState':
      return record.addressState ?? record.regionCode ?? '';
    case 'country':
    case 'addressCountry':
      return record.addressCountry ?? record.countryCode ?? '';
    default:
      return record[key] ?? '';
  }
};

const compareSortValues = (left: unknown, right: unknown) => {
  if (left == null && right == null) {
    return 0;
  }

  if (left == null) {
    return -1;
  }

  if (right == null) {
    return 1;
  }

  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }

  if (left instanceof Date && right instanceof Date) {
    return left.getTime() - right.getTime();
  }

  return String(left).localeCompare(String(right));
};

const buildOfferBoundaryKey = (
  sellerIdentifier: string | null | undefined,
  itemCode: string | null | undefined,
) => `${sellerIdentifier ?? ''}::${itemCode ?? ''}`;

const loadInventoryItemIdsByBoundary = async (
  sellerIdentifier: string,
  itemCodes: string[],
) => {
  if (itemCodes.length === 0) {
    return new Map<string, number>();
  }

  const items = await prismaInventory.item.findMany({
    where: {
      sellerIdentifier,
      itemCode: { in: itemCodes },
      deletedAt: null,
    },
    select: {
      id: true,
      sellerIdentifier: true,
      itemCode: true,
    },
  });

  return new Map(
    items.map((item) => [buildOfferBoundaryKey(item.sellerIdentifier, item.itemCode), item.id]),
  );
};

const loadRemainingQuantitiesByItemId = async (itemIds: number[]) => {
  if (itemIds.length === 0) {
    return new Map<number, number>();
  }

  const groupedMovements = await prismaInventory.movement.groupBy({
    by: ['itemId', 'direction'],
    where: {
      itemId: { in: itemIds },
    },
    _sum: {
      quantity: true,
    },
  });

  const quantitiesByItemId = new Map<number, number>();

  for (const movement of groupedMovements) {
    const currentQuantity = quantitiesByItemId.get(movement.itemId) ?? 0;
    const signedQuantity =
      movement.direction === MovementDirection.IN
        ? movement._sum.quantity ?? 0
        : -(movement._sum.quantity ?? 0);

    quantitiesByItemId.set(movement.itemId, currentQuantity + signedQuantity);
  }

  return quantitiesByItemId;
};

export const getInventoryItemListingByOfferId = async (id: number, user?: AuthUserType) => {
  const { offer, item } = await getOfferWithItemById(id, user);
  return buildListingView(offer, item);
};

export const getManageInventoryItemById = async (
  id: number,
  user: AuthUserType,
) => {
  const item = await getOwnedInventoryItemById(id, user);
  return {
    ...buildManageInventoryItemReadView(item),
    mainImage: await buildManageInventoryItemMainImageReadView(item.mainImage),
  };
};

export const getInventoryItemForEdit = async (id: number, user: AuthUserType) => {
  const listing = await getInventoryItemListingByOfferId(id, user);
  const totalStock = listing.totalStock;
  const firstComponent = listing.inventoryItem?.components?.[0];
  const firstProduct =
    firstComponent && typeof firstComponent.product === 'object'
      ? (firstComponent.product as any)
      : null;

  return {
    id: listing.id,
    title: listing.title || '',
    description: listing.description || '',
    price: listing.currentPrice?.amount || 0,
    currency: null,
    quantity: totalStock,
    minOrderUnits: listing.minOrderUnits || 1,
    availableFrom: listing.validFrom || null,
    availableTo: listing.validTo || null,
    status: listing.status,
    local: listing.local ?? true,
    online: listing.online ?? false,
    region: listing.inventoryItem?.region,
    products: (listing.inventoryItem?.components || [])
      .filter((component) => component.product != null)
      .map((component) => ({
        id: null,
        sku: component.product!.sku,
        identifier: component.identifier ?? component.imei ?? null,
        productType: component.productType,
        batteryLevel: component.product!.batteryLevel,
        condition: component.product!.condition,
        carrier: component.product!.carrier,
        catalogItem: {
          id: null,
          brand: component.product!.brand,
          model: component.product!.model,
          storage: component.product!.storage,
          color: component.product!.color,
        },
        stock: totalStock,
      })),
    brand: firstProduct?.brand,
    model: firstProduct?.model,
    storage: firstProduct?.storage,
    color: firstProduct?.color,
    condition: firstProduct?.condition,
    carrier: firstProduct?.carrier,
  };
};

export const getInventoryItemImages = async (id: number, user: AuthUserType) => {
  const { item } = await getOfferWithItemById(id, user);

  const [enhancedMainImage, enhancedImages] = await Promise.all([
    item.mainImage
      ? generatePreviewUrl(item.mainImage.blob).then((previewUrl) => ({
          id: item.mainImage!.id,
          blobId: item.mainImage!.blobId,
          checksum: item.mainImage!.blob.checksum,
          name: item.mainImage!.blob.name,
          previewUrl,
        }))
      : Promise.resolve(null),
    Promise.all(
      item.images.map(async (img) => ({
        id: img.id,
        blobId: img.blobId,
        checksum: img.blob.checksum,
        name: img.blob.name,
        previewUrl: await generatePreviewUrl(img.blob),
      })),
    ),
  ]);

  return {
    mainImage: enhancedMainImage,
    images: enhancedImages,
  };
};

export const getInventoryItemMainImage = async (id: number, user: AuthUserType) => {
  const item = await getOwnedInventoryItemById(id, user);

  const mainImage = item.mainImage
    ? {
        id: item.mainImage.id,
        blobId: item.mainImage.blobId,
        checksum: item.mainImage.blob.checksum,
        name: item.mainImage.blob.name,
        previewUrl: await generatePreviewUrl(item.mainImage.blob),
      }
    : null;

  return { mainImage };
};

export const updateInventoryItemListing = async (
  input: UpdateInventoryItemInput,
): Promise<void> => {
  const { id, price, quantity, availableFrom, availableTo, description, mainPhotoHash, photos, user } =
    input;

  const { offer: existingOffer, item } = await getOfferWithItemById(id, user);

  if (existingOffer.deletedAt !== null) {
    throw createError(StatusCodes.FORBIDDEN, 'Cannot edit deleted listing');
  }

  const now = new Date();
  if (existingOffer.expiredAt !== null && existingOffer.expiredAt <= now) {
    throw createError(StatusCodes.FORBIDDEN, 'Cannot edit expired listing');
  }

  if (availableFrom != null && availableFrom.trim()) {
    const newAvailableFrom = new Date(availableFrom);
    const existingAvailableFrom = existingOffer.validFrom;

    if (!existingAvailableFrom || newAvailableFrom.getTime() !== existingAvailableFrom.getTime()) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      if (newAvailableFrom < today) {
        throw createError(StatusCodes.BAD_REQUEST, 'Available from date cannot be in the past');
      }
    }
  }

  let fieldsChanged = false;
  const requestedImageMutation =
    photos !== undefined || mainPhotoHash !== undefined;

  await prismaInventory.$transaction(async (tx) => {
    const inventoryItemUpdates: Record<string, unknown> = {};
    const offerUpdates: Record<string, unknown> = {};

    if (availableFrom != null && availableFrom.trim()) {
      offerUpdates.validFrom = new Date(availableFrom);
      fieldsChanged = true;
    }

    if (availableTo != null && availableTo.trim()) {
      offerUpdates.validTo = new Date(availableTo);
      fieldsChanged = true;
    }

    if (description != null) {
      offerUpdates.description = description;
      fieldsChanged = true;
    }

    if (offerUpdates.validFrom || offerUpdates.validTo) {
      const newValidFrom = (offerUpdates.validFrom as Date | undefined) || existingOffer.validFrom;
      const newValidTo =
        offerUpdates.validTo !== undefined
          ? (offerUpdates.validTo as Date | null)
          : existingOffer.validTo;
      const potentialOverlaps = await tx.offersOffer.findMany({
        where: {
          id: { not: existingOffer.id },
          sellerIdentifier: existingOffer.sellerIdentifier,
          itemCode: existingOffer.itemCode,
          addressCountry: existingOffer.addressCountry,
          addressState: existingOffer.addressState,
          minOrderUnits: existingOffer.minOrderUnits,
          expiredAt: null,
          deletedAt: null,
        },
      });

      const hasOverlap = potentialOverlaps.some((otherOffer) =>
        doPeriodsOverlap(newValidFrom, newValidTo, otherOffer.validFrom, otherOffer.validTo),
      );

      if (hasOverlap) {
        throw createError(StatusCodes.CONFLICT, 'An active listing already exists for this time period');
      }
    }

    if (price != null) {
      const currentPriceAmount = existingOffer.currentPrice
        ? Number(existingOffer.currentPrice.amount)
        : null;

      if (currentPriceAmount !== price) {
        fieldsChanged = true;
        const priceRecord = await tx.offersPrice.create({
          data: {
            amount: price,
            offerId: existingOffer.id,
          },
        });
        offerUpdates.currentPriceId = priceRecord.id;
      }
    }

    if (quantity != null) {
      const stockMovements = await tx.movement.findMany({
        where: { itemId: item.id },
        select: {
          quantity: true,
          direction: true,
        },
      });

      const currentStock = stockMovements.reduce(
        (sum, movement) =>
          sum +
          (movement.direction === MovementDirection.IN
            ? movement.quantity
            : -movement.quantity),
        0,
      );

      const quantityDifference = quantity - currentStock;

      if (quantityDifference !== 0) {
        fieldsChanged = true;

        if (item.kind === ItemKind.LISTING) {
          if (quantity !== 0 && quantity !== 1) {
            throw createError(
              StatusCodes.CONFLICT,
              'Serialized inventory quantity must be 0 or 1',
            );
          }

          if (currentStock < 0 || currentStock > 1) {
            throw createError(
              StatusCodes.CONFLICT,
              'Serialized inventory quantity must remain 0 or 1',
            );
          }

          if (quantity === 1) {
            const inMovementCount = await tx.movement.count({
              where: {
                itemId: item.id,
                direction: MovementDirection.IN,
              },
            });

            if (inMovementCount > 0) {
              throw createError(
                StatusCodes.CONFLICT,
                'Serialized inventory cannot have more than one IN movement',
              );
            }

            await tx.movement.create({
              data: {
                itemId: item.id,
                direction: MovementDirection.IN,
                reason: MovementReason.STOCKED,
                quantity: 1,
              },
            });
          } else {
            await tx.movement.create({
              data: {
                itemId: item.id,
                direction: MovementDirection.OUT,
                reason: MovementReason.ADJUSTED,
                quantity: 1,
              },
            });
          }
        } else {
          await tx.movement.create({
            data: {
              itemId: item.id,
              direction:
                quantityDifference > 0 ? MovementDirection.IN : MovementDirection.OUT,
              reason:
                quantityDifference > 0 ? MovementReason.STOCKED : MovementReason.ADJUSTED,
              quantity: Math.abs(quantityDifference),
            },
          });
        }
      }
    }

    if (typeof mainPhotoHash === 'string' && mainPhotoHash.trim()) {
      fieldsChanged = true;
      const mainBlob = await tx.blob.findFirst({
        where: { checksum: mainPhotoHash },
        select: { id: true },
      });

      if (mainBlob) {
        const mainAttachment = await tx.attachment.findFirst({
          where: {
            blobId: mainBlob.id,
            attachableId: item.id,
            attachableType: 'InventoryItem',
            attachmentType: 'IMAGE',
          },
          select: { id: true },
        });

        if (mainAttachment) {
          inventoryItemUpdates.mainImageId = mainAttachment.id;
        }
      }
    }

    if (Object.keys(inventoryItemUpdates).length > 0) {
      await tx.item.update({
        where: { id: item.id },
        data: inventoryItemUpdates,
      });
    }

    if (Object.keys(offerUpdates).length > 0) {
      await tx.offersOffer.update({
        where: { id: existingOffer.id },
        data: offerUpdates,
      });
    }

    if (photos && photos.length > 0) {
      fieldsChanged = true;
      const currentPhotoChecksums = photos.map((photo) => photo.checksum).filter(Boolean);

      const existingAttachments = await tx.attachment.findMany({
        where: {
          attachableId: item.id,
          attachableType: 'InventoryItem',
          attachmentType: 'IMAGE',
        },
        include: {
          blob: true,
        },
      });

      const attachmentsToRemove = existingAttachments.filter(
        (attachment) => !currentPhotoChecksums.includes(attachment.blob.checksum),
      );

      if (attachmentsToRemove.length > 0) {
        if (
          item.mainImageId != null
          && attachmentsToRemove.some((attachment) => attachment.id === item.mainImageId)
        ) {
          await tx.item.update({
            where: { id: item.id },
            data: {
              mainImageId: null,
            },
          });
        }

        await tx.attachment.deleteMany({
          where: {
            id: { in: attachmentsToRemove.map((attachment) => attachment.id) },
          },
        });
      }

      const blobs = await resolveInventoryPhotoBlobs(
        tx,
        item.sellerIdentifier,
        photos as InventoryPhotoInput[],
      );

      const checksumToBlobMap = new Map(
        blobs.map((blob) => [blob.checksum, blob]),
      );

      for (const photo of photos) {
        const blob = checksumToBlobMap.get(photo.checksum);

        if (!blob) {
          throw createError(StatusCodes.BAD_REQUEST, 'Photo upload failed');
        }

        await tx.attachment.upsert({
          where: {
            blobId_attachableId_attachableType_attachmentType: {
              blobId: blob.id,
              attachableId: item.id,
              attachableType: 'InventoryItem',
              attachmentType: 'IMAGE',
            },
          },
          update: {},
          create: {
            attachmentType: 'IMAGE',
            blobId: blob.id,
            attachableId: item.id,
            attachableType: 'InventoryItem',
          },
        });
      }

      const normalizedMainPhotoHash =
        typeof mainPhotoHash === 'string' && mainPhotoHash.trim() ? mainPhotoHash : null;
      const removedCurrentMainImage =
        item.mainImageId != null
        && attachmentsToRemove.some((attachment) => attachment.id === item.mainImageId);

      if (normalizedMainPhotoHash || removedCurrentMainImage) {
        const nextMainAttachment = normalizedMainPhotoHash
          ? await tx.attachment.findFirst({
              where: {
                attachableId: item.id,
                attachableType: 'InventoryItem',
                attachmentType: 'IMAGE',
                blob: {
                  checksum: normalizedMainPhotoHash,
                },
              },
              select: { id: true },
            })
          : null;

        await tx.item.update({
          where: { id: item.id },
          data: {
            mainImageId: nextMainAttachment?.id ?? null,
          },
        });
      }
    }
  });

  if (requestedImageMutation) {
    const committedItem = await prismaInventory.item.findUnique({
      where: { id: item.id },
      include: itemListingInclude,
    });

    if (committedItem && imageStateChanged(item, committedItem as BoundaryItem)) {
      await notifyOffersOnImageUpdate(committedItem as BoundaryItem);
    }
  }

  if (!fieldsChanged) {
    return;
  }

  const refreshedOffer = await prismaInventory.offersOffer.findUnique({
    where: { id },
    include: {
      latestPublication: true,
    },
  });

  if (!refreshedOffer?.latestPublication || refreshedOffer.status !== 'ACTIVE') {
    return;
  }

  const remainingQuantity = await calculateRemainingQuantity(item.id);

  if (remainingQuantity > 0) {
    await touchPublishedOffer(id);
  } else {
    await delistMirroredOffer(id);
  }
};

export const getInventoryItems = async (
  _filters: Record<string, string | number | boolean | string[] | number[] | boolean[] | null>[],
  paginationParams: any,
  sortBy?: Record<string, InventoryPrisma.SortOrder>[],
  user?: AuthUserType,
): Promise<{ data: any[]; total: number; filteredTotal: number }> => {
  if (user?.accountIdentifier === undefined) {
    return { data: [], total: 0, filteredTotal: 0 };
  }

  const { take, skip } = await getPaginationQueryParams(paginationParams);

  const where: InventoryPrisma.ItemWhereInput = {
    sellerIdentifier: user.accountIdentifier,
    deletedAt: null,
  };

  const filters = Array.isArray(_filters) ? _filters : [];
  const requestedCodes = Array.from(
    new Set(
      filters.flatMap((filter) => {
        const value = filter?.code;

        if (Array.isArray(value)) {
          return value
            .map((entry) => String(entry).trim())
            .filter((entry) => entry.length > 0);
        }

        if (typeof value === 'string' && value.trim().length > 0) {
          return [value.trim()];
        }

        return [];
      }),
    ),
  );

  if (requestedCodes.length > 0) {
    where.itemCode = {
      in: requestedCodes,
    };
  }

  const orderBy =
    sortBy && sortBy.length > 0
      ? sortBy.map((sortItem) => {
          const [field, direction] = Object.entries(sortItem)[0] as [
            string,
            InventoryPrisma.SortOrder,
          ];

          if (field === 'code') {
            return { itemCode: direction };
          }

          return { [field]: direction };
        })
      : [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

  const [total, items] = await Promise.all([
    prismaInventory.item.count({ where }),
    prismaInventory.item.findMany({
      where,
      include: itemListingInclude,
      orderBy,
      take,
      skip,
    }),
  ]);

  if (items.length === 0) {
    return { data: [], total, filteredTotal: total };
  }

  const movementGroups = await prismaInventory.movement.groupBy({
    by: ['itemId', 'direction', 'reason'],
    where: {
      itemId: {
        in: items.map((item) => item.id),
      },
    },
    _sum: {
      quantity: true,
    },
  });

  const aggregationByItemId = new Map<number, InventoryMovementAggregation>();

  items.forEach((item) => {
    aggregationByItemId.set(item.id, createEmptyInventoryMovementAggregation());
  });

  movementGroups.forEach((group) => {
    const current =
      aggregationByItemId.get(group.itemId) ??
      createEmptyInventoryMovementAggregation();
    const quantity = group._sum.quantity ?? 0;

    if (group.direction === MovementDirection.IN) {
      current.totalInboundUnits += quantity;
      current.availableUnits += quantity;
    } else {
      current.totalOutboundUnits += quantity;
      current.availableUnits -= quantity;

      if (group.reason === MovementReason.SOLD) {
        current.soldUnits += quantity;
      }
    }

    aggregationByItemId.set(group.itemId, current);
  });

  const data = await Promise.all(
    items.map((item) =>
      buildManageInventoryItemListReadView(
        item,
        aggregationByItemId.get(item.id) ??
          createEmptyInventoryMovementAggregation(),
      ),
    ),
  );

  return {
    data,
    total,
    filteredTotal: total,
  };
};

type InventoryMovementAggregation = {
  availableUnits: number;
  totalInboundUnits: number;
  totalOutboundUnits: number;
  soldUnits: number;
};

type InventoryItemMovementsResponse = {
  records: Array<{
    id: number;
    quantity: number;
    direction: MovementDirection;
    reason: MovementReason;
    createdAt: Date;
    metadata: InventoryPrisma.JsonValue | null;
  }>;
  aggregation: InventoryMovementAggregation;
  total: number;
  filteredTotal: number;
};

export const getInventoryItemMovements = async (
  id: number,
  paginationParams: PaginationInputType,
  user?: AuthUserType,
): Promise<InventoryItemMovementsResponse> => {
  const item = await getOwnedInventoryItemById(id, user);
  const { take, skip } = await getPaginationQueryParams(paginationParams);

  const [records, total, directionGroups, soldAggregate] = await Promise.all([
    prismaInventory.movement.findMany({
      where: {
        itemId: item.id,
      },
      orderBy: {
        createdAt: 'desc',
      },
      take,
      skip,
      select: {
        id: true,
        quantity: true,
        direction: true,
        reason: true,
        createdAt: true,
        metadata: true,
      },
    }),
    prismaInventory.movement.count({
      where: {
        itemId: item.id,
      },
    }),
    prismaInventory.movement.groupBy({
      by: ['direction'],
      where: {
        itemId: item.id,
      },
      _sum: {
        quantity: true,
      },
    }),
    prismaInventory.movement.aggregate({
      where: {
        itemId: item.id,
        direction: MovementDirection.OUT,
        reason: MovementReason.SOLD,
      },
      _sum: {
        quantity: true,
      },
    }),
  ]);

  const totalInboundUnits =
    directionGroups.find((group) => group.direction === MovementDirection.IN)?._sum
      .quantity ?? 0;
  const totalOutboundUnits =
    directionGroups.find((group) => group.direction === MovementDirection.OUT)?._sum
      .quantity ?? 0;

  return {
    records,
    aggregation: {
      availableUnits: totalInboundUnits - totalOutboundUnits,
      totalInboundUnits,
      totalOutboundUnits,
      soldUnits: soldAggregate._sum.quantity ?? 0,
    },
    total,
    filteredTotal: total,
  };
};

export const getInventoryItemCdnUrls = async (id: number, user: AuthUserType) => {
  const item = await getOwnedInventoryItemById(id, user);

  const mainImage = item.mainImage
    ? {
        id: item.mainImage.id,
        blobId: item.mainImage.blobId,
        checksum: item.mainImage.blob.checksum,
        assetRef: item.mainImage.blob.assetRef ?? null,
        name: item.mainImage.blob.name,
        url: blobKeyToCDNUrl(item.mainImage.blob.key),
        isMain: true,
      }
    : null;

  const images = item.images.map((img) => ({
      id: img.id,
      blobId: img.blobId,
      checksum: img.blob.checksum,
      assetRef: img.blob.assetRef ?? null,
      name: img.blob.name,
      key: img.blob.key,
      size: img.blob.size,
    mimeType: img.blob.fileType,
    url: blobKeyToCDNUrl(img.blob.key),
    isMain: img.id === item.mainImageId,
  }));

  return {
    mainImage,
    images,
  };
};

export const getInventoryItemsBatchCdnUrls = async (
  listingIds: number[],
  user: AuthUserType,
): Promise<
  Record<
    string,
    Array<{
      id: number;
      blobId: number;
      checksum: string;
      assetRef: string | null;
      name: string;
      url: string;
      isMain: boolean;
    }>
  >
> => {
  const offers = await prismaInventory.offersOffer.findMany({
    where: {
      id: { in: listingIds },
      deletedAt: null,
      sellerIdentifier: user.accountIdentifier,
    },
    select: {
      id: true,
      itemCode: true,
      sellerIdentifier: true,
    },
  });

  const itemCodes = Array.from(
    new Set(offers.map((offer) => offer.itemCode).filter((itemCode): itemCode is string => !!itemCode)),
  );

  const items = await prismaInventory.item.findMany({
    where: {
      sellerIdentifier: user.accountIdentifier,
      itemCode: { in: itemCodes },
    },
    include: {
      images: {
        where: {
          attachableType: 'InventoryItem',
          attachmentType: 'IMAGE',
          deletedAt: null,
        },
        include: { blob: true },
      },
    },
  });

  const itemsByCode = new Map(items.map((item) => [item.itemCode, item]));
  const attachmentsMap: Record<string, any[]> = {};

  for (const offer of offers) {
    const item = offer.itemCode ? itemsByCode.get(offer.itemCode) : null;

    if (!item) {
      attachmentsMap[offer.id] = [];
      continue;
    }

    attachmentsMap[offer.id] = item.images.map((img) => ({
      id: img.id,
      blobId: img.blobId,
      checksum: img.blob.checksum,
      assetRef: img.blob.assetRef ?? null,
      name: img.blob.name,
      url: blobKeyToCDNUrl(img.blob.key),
      isMain: img.id === item.mainImageId,
    }));
  }

  return attachmentsMap;
};
