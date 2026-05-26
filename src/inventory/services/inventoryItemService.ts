import {
  ComponentChildType,
  ItemKind,
  MovementDirection,
  MovementReason,
  Prisma,
  ProductType,
} from '@/lib/prismaInventoryTypes';
import createError, { HttpError } from 'http-errors';
import { StatusCodes } from 'http-status-codes';

import prismaInventory from '@/lib/prismaInventory';
import {
  buildInventorySnapshotPhoto,
  resolveInventoryPhotoBlobs,
  type InventoryPhotoInput,
} from '@/inventory/services/itemImageService';
import { notifyOffersOnImageUpdate } from '@/inventory/services/notifyOffersOnImageUpdate';
import { inventoryItemImageRelationsInclude } from '@/inventory/services/notifyOffersOnImageUpdate';
import { notifyOffersOnZeroStock } from '@/inventory/services/notifyOffersOnZeroStock';
import { consumePersonalInventoryFallbackCode } from '@/inventory/services/personalFallbackCodeService';
import { createInventoryCode } from '@/inventory/utils/createInventoryCode';
import { calculateRemainingQuantity } from '@/services/stockService';
import { getUserInventoryAddress } from '@/services/userService';
import type {
  CreateInventoryItemBoundaryInput,
  InventoryComponentInput,
  InventoryProductSnapshotInput,
  ResolveInventoryItemBoundaryInput,
  UpdateInventoryItemBoundaryInput,
  WriteInventoryBoundaryInput,
} from '@/inventory/validation/validateCreateInventoryItemInput';
import type { AuthUserType } from '@/types/userType';

type InventoryTransactionClient = Omit<
  typeof prismaInventory,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

type NormalizedProductSnapshot = {
  sellerIdentifier: string;
  sku: string;
  batteryLevel: number | null;
  brand: { key: string; name: string };
  model: { key: string; name: string };
  color: { key: string; name: string; hexValue: string | null };
  storage: { key: string; name: string };
  condition: { key: string; label: string };
  carrier: { key: string; name: string } | null;
};

type NormalizedComponentInput = {
  sku: string;
  count: number;
  productType: ProductType;
  imei?: string;
  fallbackCode?: string;
  productSnapshot: NormalizedProductSnapshot;
};

type BoundaryBlob = {
  id: number;
  checksum: string;
  key: string;
  name: string;
  size: number | null;
  fileType: string;
  extension: string;
  assetRef?: string | null;
};

type BoundaryItem = {
  id: number;
  kind: ItemKind;
  itemCode: string;
  sellerIdentifier: string;
  addressLine1: string | null;
  addressLine2: string | null;
  addressCity: string | null;
  addressStateCode: string | null;
  addressPostalCode: string | null;
  addressCountryCode: string | null;
  addressLatitude: number | null;
  addressLongitude: number | null;
  deletedAt: Date | null;
  mainImage: {
    blob: BoundaryBlob;
  } | null;
  images: Array<{
    blob: BoundaryBlob;
  }>;
  components: Array<{
    id: number;
    childType: ComponentChildType;
    componentSnapshot: unknown;
    position: number | null;
    instance: {
      id: number;
      identifier: string;
      sku: string;
      productType: ProductType;
    } | null;
    bundle: {
      id: number;
      sku: string;
      productType: ProductType;
      count: number;
    } | null;
  }>;
};

type InventoryPhoto = {
  blobId: number;
  checksum: string;
  key: string;
  name: string | null;
  mimeType: string;
  size: number;
  assetRef: string | null;
  cdnUrl: string;
};

type InventorySnapshotComponent = {
  sku: string;
  count: number;
  productType: ProductType;
  productSnapshot: NormalizedProductSnapshot;
  imei?: string;
};

type InventorySnapshot = {
  kind: ItemKind;
  code: string;
  sellerIdentifier: string;
  addressLine1: string | null;
  addressLine2: string | null;
  addressCity: string | null;
  addressStateCode: string | null;
  addressPostalCode: string | null;
  addressCountryCode: string | null;
  addressLatitude: number | null;
  addressLongitude: number | null;
  mainPhoto: InventoryPhoto | null;
  photos: InventoryPhoto[];
  components: InventorySnapshotComponent[];
};

type InventoryBoundaryResult = {
  created: boolean;
  data: InventoryResolutionResult;
};

type InventoryUpdateResult = {
  data: InventoryResolutionResult;
};

type ResolvedInventoryItem = {
  id: number;
  kind: ItemKind;
  code: string;
  sellerIdentifier: string;
  quantity: number;
  mainPhoto: InventoryPhoto | null;
  photos: InventoryPhoto[];
  invSnapshot: InventorySnapshot;
};

type InventoryResolutionResult = {
  resolvedInventoryItem: ResolvedInventoryItem | null;
};

type ResolvedComponentLeaf = {
  childType: ComponentChildType;
  instanceId: number | null;
  bundleId: number | null;
  sku: string;
  count: number;
  productType: ProductType;
  imei?: string;
};

type ImeiConflictDetails = {
  title: string;
  messageBeforeLink?: string;
  messageAfterLink?: string;
  link?: {
    label: 'here';
    href: string;
  };
};

type SerializedComponentBinding = {
  componentId: number;
  itemId: number;
  item: BoundaryItem | null;
};

type QuantitySyncResult = {
  direction: MovementDirection;
  previousQuantity: number;
  nextQuantity: number;
  movementId: number;
};

const itemBoundaryInclude = {
  ...inventoryItemImageRelationsInclude,
  components: {
    orderBy: {
      position: 'asc',
    },
    include: {
      instance: true,
      bundle: true,
    },
  },
} as const;

const normalizeProductSnapshot = (
  snapshot: InventoryProductSnapshotInput,
): NormalizedProductSnapshot => ({
  sellerIdentifier: snapshot.sellerIdentifier,
  sku: snapshot.sku,
  batteryLevel: snapshot.batteryLevel ?? null,
  brand: snapshot.brand,
  model: snapshot.model,
  color: {
    ...snapshot.color,
    hexValue: snapshot.color.hexValue ?? null,
  },
  storage: snapshot.storage,
  condition: snapshot.condition,
  carrier: snapshot.carrier ?? null,
});

const normalizeInputComponent = (
  component: InventoryComponentInput,
): NormalizedComponentInput => ({
  sku: component.sku,
  count: component.count,
  productType: component.productType,
  ...(component.imei ? { imei: component.imei } : {}),
  ...(component.fallbackCode ? { fallbackCode: component.fallbackCode } : {}),
  productSnapshot: normalizeProductSnapshot(component.productSnapshot),
});

const normalizeInputComponents = (components: InventoryComponentInput[]) =>
  components.map((component) => normalizeInputComponent(component));

const normalizeStoredProductSnapshot = (
  snapshot: unknown,
  sellerIdentifier: string,
  sku: string,
): NormalizedProductSnapshot => {
  const value =
    snapshot && typeof snapshot === 'object'
      ? (snapshot as Partial<NormalizedProductSnapshot>)
      : {};

  return {
    sellerIdentifier: value.sellerIdentifier ?? sellerIdentifier,
    sku: value.sku ?? sku,
    batteryLevel: value.batteryLevel ?? null,
    brand: value.brand ?? { key: '', name: '' },
    model: value.model ?? { key: '', name: '' },
    color: {
      key: value.color?.key ?? '',
      name: value.color?.name ?? '',
      hexValue: value.color?.hexValue ?? null,
    },
    storage: value.storage ?? { key: '', name: '' },
    condition: value.condition ?? { key: '', label: '' },
    carrier: value.carrier ?? null,
  };
};

const normalizeInventoryPhotos = (
  photos: InventoryPhotoInput[],
  mainPhotoHash?: string | null,
) => {
  let finalMainPhotoHash = mainPhotoHash ?? null;
  const photoChecksums = photos.map((photo) => photo.checksum);
  const uniquePhotoChecksums = Array.from(new Set(photoChecksums));

  if (photoChecksums.length !== uniquePhotoChecksums.length) {
    throw createError(StatusCodes.BAD_REQUEST, 'Photo incomplete');
  }

  if (uniquePhotoChecksums.length === 0) {
    finalMainPhotoHash = null;
  }

  if (!finalMainPhotoHash && uniquePhotoChecksums.length > 0) {
    finalMainPhotoHash = uniquePhotoChecksums[0];
  }

  if (finalMainPhotoHash && !uniquePhotoChecksums.includes(finalMainPhotoHash)) {
    throw createError(StatusCodes.BAD_REQUEST, 'Photo invalid');
  }

  return {
    uniquePhotoChecksums,
    finalMainPhotoHash,
  };
};

const assertCreatePhotosPresent = (photos: InventoryPhotoInput[]) => {
  if (photos.length === 0) {
    throw createError(StatusCodes.BAD_REQUEST, 'At least one photo is required');
  }
};

const getComponentLeaf = (
  component: BoundaryItem['components'][number],
): InventorySnapshotComponent => {
  const snapshotContainer =
    component.componentSnapshot && typeof component.componentSnapshot === 'object'
      ? (component.componentSnapshot as {
          productSnapshot?: unknown;
          imei?: string;
        })
      : {};

  if (component.childType === ComponentChildType.INSTANCE && component.instance) {
    return {
      sku: component.instance.sku,
      count: 1,
      productType: component.instance.productType,
      productSnapshot: normalizeStoredProductSnapshot(
        snapshotContainer.productSnapshot ?? component.componentSnapshot,
        '',
        component.instance.sku,
      ),
      imei: component.instance.identifier,
    };
  }

  if (component.childType === ComponentChildType.BUNDLE && component.bundle) {
    return {
      sku: component.bundle.sku,
      count: component.bundle.count,
      productType: component.bundle.productType,
      productSnapshot: normalizeStoredProductSnapshot(
        snapshotContainer.productSnapshot ?? component.componentSnapshot,
        '',
        component.bundle.sku,
      ),
    };
  }

  throw createError(StatusCodes.INTERNAL_SERVER_ERROR, 'Component leaf missing');
};

const buildSnapshotComponent = (
  item: BoundaryItem,
  component: BoundaryItem['components'][number],
): InventorySnapshotComponent => {
  const leaf = getComponentLeaf(component);

  return {
    ...leaf,
    productSnapshot: normalizeStoredProductSnapshot(
      leaf.productSnapshot,
      item.sellerIdentifier,
      leaf.sku,
    ),
  };
};

export const buildInvSnapshot = (
  item: BoundaryItem,
): InventorySnapshot => ({
  kind: item.kind,
  code: item.itemCode,
  sellerIdentifier: item.sellerIdentifier,
  addressLine1: item.addressLine1,
  addressLine2: item.addressLine2,
  addressCity: item.addressCity,
  addressStateCode: item.addressStateCode,
  addressPostalCode: item.addressPostalCode,
  addressCountryCode: item.addressCountryCode,
  addressLatitude: item.addressLatitude,
  addressLongitude: item.addressLongitude,
  mainPhoto: item.mainImage ? buildInventorySnapshotPhoto(item.mainImage) : null,
  photos: item.images.map((attachment) => buildInventorySnapshotPhoto(attachment)),
  components: item.components.map((component) => buildSnapshotComponent(item, component)),
});

const assertInventorySnapshotSeller = (
  sellerIdentifier: string,
  components: NormalizedComponentInput[],
) => {
  for (const component of components) {
    if (component.productSnapshot.sellerIdentifier !== sellerIdentifier) {
      throw createError(StatusCodes.FORBIDDEN, 'Product snapshot seller invalid');
    }
  }
};

const getItemQuantity = async (tx: InventoryTransactionClient, itemId: number) => {
  const movements = await tx.movement.findMany({
    where: { itemId },
    select: {
      quantity: true,
      direction: true,
    },
  });

  return movements.reduce(
    (total, movement) =>
      total +
      (movement.direction === MovementDirection.IN
        ? movement.quantity
        : -movement.quantity),
    0,
  );
};

const createMovement = async (
  tx: InventoryTransactionClient,
  itemId: number,
  direction: MovementDirection,
  reason: MovementReason,
  quantity: number,
) => {
  return tx.movement.create({
    data: {
      itemId,
      direction,
      reason,
      quantity,
    },
  });
};

const ensureSerializedQuantity = (quantity: number) => {
  if (quantity !== 0 && quantity !== 1) {
    throw createError(
      StatusCodes.CONFLICT,
      'Serialized inventory quantity must be 0 or 1',
    );
  }
};

const IMEI_CONFLICT_TITLE = 'IMEI Already Used';

const createImeiConflictError = (
  message: string,
  details: ImeiConflictDetails,
) => {
  const error = createError(StatusCodes.CONFLICT, message) as HttpError & {
    details: ImeiConflictDetails;
  };

  error.name = 'IMEI_CONFLICT';
  error.details = details;

  return error;
};

const createGenericImeiConflictError = () =>
  createImeiConflictError('The provided IMEI is already used for a previous listing.', {
    title: IMEI_CONFLICT_TITLE,
  });

const buildImeiConflictError = async (
  sellerIdentifier: string,
  existingItem: Pick<BoundaryItem, 'id' | 'itemCode' | 'sellerIdentifier'>,
) => {
  if (existingItem.sellerIdentifier !== sellerIdentifier) {
    return createImeiConflictError(
      'The provided IMEI is already used in a different listing. If you believe this is an error, please report it to support@cellifi.com and include the IMEI in the email body.',
      {
        title: IMEI_CONFLICT_TITLE,
      },
    );
  }

  const listingViewId = await findExistingManageListingViewId(
    existingItem.sellerIdentifier,
    existingItem.itemCode,
  );

  if (!listingViewId) {
    return createImeiConflictError(
      'The provided IMEI is already used for a previous listing.',
      {
        title: IMEI_CONFLICT_TITLE,
      },
    );
  }

  return createImeiConflictError(
    'The provided IMEI is already used for a previous listing. You can view it here.',
    {
      title: IMEI_CONFLICT_TITLE,
      messageBeforeLink:
        'The provided IMEI is already used for a previous listing. You can view it ',
      messageAfterLink: '.',
      link: {
        label: 'here',
        href: `/manage/listings/${listingViewId}`,
      },
    },
  );
};

const syncStockItemQuantity = async (
  tx: InventoryTransactionClient,
  itemId: number,
  targetQuantity: number,
) => {
  const currentQuantity = await getItemQuantity(tx, itemId);
  const quantityDifference = targetQuantity - currentQuantity;

  if (quantityDifference === 0) {
    return null;
  }

  const movement = await createMovement(
    tx,
    itemId,
    quantityDifference > 0 ? MovementDirection.IN : MovementDirection.OUT,
    quantityDifference > 0 ? MovementReason.STOCKED : MovementReason.ADJUSTED,
    Math.abs(quantityDifference),
  );

  return {
    direction: quantityDifference > 0 ? MovementDirection.IN : MovementDirection.OUT,
    previousQuantity: currentQuantity,
    nextQuantity: targetQuantity,
    movementId: movement.id,
  } satisfies QuantitySyncResult;
};

const syncListingItemQuantity = async (
  tx: InventoryTransactionClient,
  itemId: number,
  targetQuantity: number,
) => {
  ensureSerializedQuantity(targetQuantity);

  const currentQuantity = await getItemQuantity(tx, itemId);

  if (currentQuantity === targetQuantity) {
    return null;
  }

  if (currentQuantity < 0 || currentQuantity > 1) {
    throw createError(
      StatusCodes.CONFLICT,
      'Serialized inventory quantity must remain 0 or 1',
    );
  }

  if (targetQuantity === 1) {
    const inMovementCount = await tx.movement.count({
      where: {
        itemId,
        direction: MovementDirection.IN,
      },
    });

    if (inMovementCount > 0) {
      throw createError(
        StatusCodes.CONFLICT,
        'Serialized inventory cannot have more than one IN movement',
      );
    }

    const movement = await createMovement(
      tx,
      itemId,
      MovementDirection.IN,
      MovementReason.STOCKED,
      1,
    );

    return {
      direction: MovementDirection.IN,
      previousQuantity: currentQuantity,
      nextQuantity: 1,
      movementId: movement.id,
    } satisfies QuantitySyncResult;
  }

  if (currentQuantity !== 1) {
    throw createError(
      StatusCodes.CONFLICT,
      'Serialized inventory quantity must remain 0 or 1',
    );
  }

  const movement = await createMovement(
    tx,
    itemId,
    MovementDirection.OUT,
    MovementReason.ADJUSTED,
    1,
  );

  return {
    direction: MovementDirection.OUT,
    previousQuantity: currentQuantity,
    nextQuantity: 0,
    movementId: movement.id,
  } satisfies QuantitySyncResult;
};

const syncInventoryItemPhotos = async (
  tx: InventoryTransactionClient,
  itemId: number,
  sellerIdentifier: string,
  photos: InventoryPhotoInput[],
  mainPhotoHash?: string | null,
) => {
  const { uniquePhotoChecksums, finalMainPhotoHash } = normalizeInventoryPhotos(
    photos,
    mainPhotoHash,
  );
  const resolvedBlobs = await resolveInventoryPhotoBlobs(
    tx,
    sellerIdentifier,
    photos,
  );
  const desiredBlobIds = new Set(resolvedBlobs.map((blob) => blob.id));

  const existingAttachments = await tx.attachment.findMany({
    where: {
      attachableId: itemId,
      attachableType: 'InventoryItem',
      attachmentType: 'IMAGE',
    },
    include: {
      blob: true,
    },
  });

  if (existingAttachments.length > 0) {
    const attachmentsToRemove = existingAttachments.filter(
      (attachment) => !desiredBlobIds.has(attachment.blob.id),
    );

    if (attachmentsToRemove.length > 0) {
      const currentItem = await tx.item.findUnique({
        where: { id: itemId },
        select: {
          mainImageId: true,
        },
      });

      if (
        currentItem?.mainImageId
        && attachmentsToRemove.some((attachment) => attachment.id === currentItem.mainImageId)
      ) {
        await tx.item.update({
          where: { id: itemId },
          data: {
            mainImageId: null,
          },
        });
      }

      await tx.attachment.deleteMany({
        where: {
          id: {
            in: attachmentsToRemove.map((attachment) => attachment.id),
          },
        },
      });
    }
  }

  if (uniquePhotoChecksums.length === 0) {
    await tx.item.update({
      where: { id: itemId },
      data: {
        mainImageId: null,
      },
    });

    return;
  }

  await tx.attachment.createMany({
    data: resolvedBlobs.map((blob) => ({
      attachmentType: 'IMAGE',
      blobId: blob.id,
      attachableId: itemId,
      attachableType: 'InventoryItem',
    })),
    skipDuplicates: true,
  });

  const mainBlob = resolvedBlobs.find(
    (blob) => blob.checksum === finalMainPhotoHash,
  );

  if (!mainBlob) {
    throw createError(StatusCodes.BAD_REQUEST, 'Photo invalid');
  }

  const mainAttachment = await tx.attachment.findFirst({
    where: {
      blobId: mainBlob.id,
      attachableId: itemId,
      attachableType: 'InventoryItem',
      attachmentType: 'IMAGE',
    },
  });

  await tx.item.update({
    where: { id: itemId },
    data: {
      mainImageId: mainAttachment?.id ?? null,
    },
  });
};

const syncInventoryItemMainPhotoSelection = async (
  tx: InventoryTransactionClient,
  itemId: number,
  mainPhotoHash: string | null,
) => {
  if (mainPhotoHash === null) {
    await tx.item.update({
      where: { id: itemId },
      data: {
        mainImageId: null,
      },
    });

    return;
  }

  const mainAttachment = await tx.attachment.findFirst({
    where: {
      attachableId: itemId,
      attachableType: 'InventoryItem',
      attachmentType: 'IMAGE',
      deletedAt: null,
      blob: {
        checksum: mainPhotoHash,
      },
    },
  });

  if (!mainAttachment) {
    throw createError(StatusCodes.BAD_REQUEST, 'Photo invalid');
  }

  await tx.item.update({
    where: { id: itemId },
    data: {
      mainImageId: mainAttachment.id,
    },
  });
};

const buildInventoryResolution = async (item: BoundaryItem): Promise<ResolvedInventoryItem> => {
  const invSnapshot = buildInvSnapshot(item);
  const quantity = await calculateRemainingQuantity(item.id);

  return {
    id: item.id,
    kind: item.kind,
    code: invSnapshot.code,
    sellerIdentifier: item.sellerIdentifier,
    quantity,
    mainPhoto: invSnapshot.mainPhoto,
    photos: invSnapshot.photos,
    invSnapshot,
  };
};

const findItemByCode = async (sellerIdentifier: string, itemCode: string) =>
  prismaInventory.item.findFirst({
    where: {
      sellerIdentifier,
      itemCode,
    },
    include: itemBoundaryInclude,
  });

const findSerializedComponentBinding = async (
  identifier: string,
): Promise<SerializedComponentBinding | null> => {
  const component = await prismaInventory.component.findFirst({
    where: {
      childType: ComponentChildType.INSTANCE,
      instance: {
        is: {
          identifier,
        },
      },
    },
    select: {
      id: true,
      itemId: true,
    },
  });

  if (!component) {
    return null;
  }

  const item = (await prismaInventory.item.findUnique({
    where: {
      id: component.itemId,
    },
    include: itemBoundaryInclude,
  })) as BoundaryItem | null;

  return {
    componentId: component.id,
    itemId: component.itemId,
    item,
  };
};

const buildRequestedItemCode = (components: NormalizedComponentInput[]) =>
  createInventoryCode(
    components.map((component) => ({
      sku: component.sku,
      count: component.imei || component.fallbackCode ? 1 : component.count,
      productType: component.productType,
      identifier: component.imei ?? null,
    })),
  );

const ensureNoSerializedConflicts = async (
  sellerIdentifier: string,
  itemCode: string,
  components: NormalizedComponentInput[],
) => {
  const imeis = Array.from(
    new Set(
      components
        .map((component) => component.imei)
        .filter((value): value is string => Boolean(value)),
    ),
  );

  for (const imei of imeis) {
    const existingBinding = await findSerializedComponentBinding(imei);

    if (!existingBinding) {
      continue;
    }

    if (!existingBinding.item) {
      throw createGenericImeiConflictError();
    }

    const existingItem = existingBinding.item;

    if (
      existingItem &&
      (existingItem.itemCode !== itemCode ||
        existingItem.sellerIdentifier !== sellerIdentifier)
    ) {
      throw await buildImeiConflictError(sellerIdentifier, existingItem);
    }
  }
};

const isComponentInstanceUniqueConstraintError = (
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError => {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    error.meta?.modelName === 'Component' &&
    Array.isArray(error.meta?.target) &&
    error.meta.target.includes('instance_id')
  );
};

const remapInstanceConstraintError = async (
  error: unknown,
  sellerIdentifier: string,
  components: NormalizedComponentInput[],
) => {
  if (!isComponentInstanceUniqueConstraintError(error)) {
    throw error;
  }

  const imeis = Array.from(
    new Set(
      components
        .map((component) => component.imei)
        .filter((value): value is string => Boolean(value)),
    ),
  );

  for (const imei of imeis) {
    const existingBinding = await findSerializedComponentBinding(imei);

    if (!existingBinding?.item) {
      throw createGenericImeiConflictError();
    }

    throw await buildImeiConflictError(sellerIdentifier, existingBinding.item);
  }

  throw error;
};

const consumePersonalFallbackCodes = async (
  sellerIdentifier: string,
  user: AuthUserType,
  components: NormalizedComponentInput[],
) => {
  if (user.accountType !== 'PERSONAL') {
    return;
  }

  for (const component of components) {
    if (!component.fallbackCode) {
      continue;
    }

    await consumePersonalInventoryFallbackCode({
      accountIdentifier: sellerIdentifier,
      fallbackCode: component.fallbackCode,
    });
  }
};

const resolveComponentLeaf = async (
  tx: InventoryTransactionClient,
  component: NormalizedComponentInput,
): Promise<ResolvedComponentLeaf> => {
  if (component.imei) {
    const instance = await tx.instance.upsert({
      where: {
        identifier_sku_productType: {
          identifier: component.imei,
          sku: component.sku,
          productType: component.productType,
        },
      },
      create: {
        identifier: component.imei,
        sku: component.sku,
        productType: component.productType,
      },
      update: {},
    });

    return {
      childType: ComponentChildType.INSTANCE,
      instanceId: instance.id,
      bundleId: null,
      sku: instance.sku,
      count: 1,
      productType: instance.productType,
      imei: instance.identifier,
    };
  }

  const bundleCount = component.fallbackCode ? 1 : component.count;
  const bundle = await tx.bundle.upsert({
    where: {
      sku_productType_count: {
        sku: component.sku,
        productType: component.productType,
        count: bundleCount,
      },
    },
    create: {
      sku: component.sku,
      productType: component.productType,
      count: bundleCount,
    },
    update: {},
  });

  return {
    childType: ComponentChildType.BUNDLE,
    instanceId: null,
    bundleId: bundle.id,
    sku: bundle.sku,
    count: bundle.count,
    productType: bundle.productType,
  };
};

const buildStoredComponentSnapshot = (
  component: NormalizedComponentInput,
  resolvedLeaf: ResolvedComponentLeaf,
) => ({
  sku: resolvedLeaf.sku,
  count: resolvedLeaf.count,
  productType: resolvedLeaf.productType,
  ...(resolvedLeaf.imei ? { imei: resolvedLeaf.imei } : {}),
  productSnapshot: component.productSnapshot,
});

const findExistingManageListingViewId = async (
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

export const resolveInventoryItemBoundary = async (
  user: AuthUserType,
  input: ResolveInventoryItemBoundaryInput,
): Promise<InventoryResolutionResult> => {
  const sellerIdentifier = user.accountIdentifier;
  if (!sellerIdentifier) {
    throw createError(StatusCodes.BAD_REQUEST, 'Seller required');
  }

  const components = normalizeInputComponents(input.components);
  assertInventorySnapshotSeller(sellerIdentifier, components);
  const itemCode = buildRequestedItemCode(components);

  await ensureNoSerializedConflicts(sellerIdentifier, itemCode, components);

  const item = (await findItemByCode(sellerIdentifier, itemCode)) as BoundaryItem | null;

  if (!item) {
    return { resolvedInventoryItem: null };
  }

  if (item.kind !== input.kind) {
    throw createError(
      StatusCodes.CONFLICT,
      'Inventory item already exists for this composition',
    );
  }

  return {
    resolvedInventoryItem: await buildInventoryResolution(item),
  };
};

export const createInventoryItemBoundary = async (
  user: AuthUserType,
  input: CreateInventoryItemBoundaryInput,
): Promise<InventoryBoundaryResult> => {
  const sellerIdentifier = user.accountIdentifier;
  if (!sellerIdentifier) {
    throw createError(StatusCodes.BAD_REQUEST, 'Seller required');
  }

  const components = normalizeInputComponents(input.components);
  assertInventorySnapshotSeller(sellerIdentifier, components);
  const itemCode = buildRequestedItemCode(components);
  const requestedCreateQuantity =
    input.kind === ItemKind.LISTING ? input.quantity ?? 1 : input.quantity;

  if (input.kind === ItemKind.LISTING) {
    ensureSerializedQuantity(requestedCreateQuantity);
  }

  await ensureNoSerializedConflicts(sellerIdentifier, itemCode, components);

  const existingItem = (await findItemByCode(sellerIdentifier, itemCode)) as BoundaryItem | null;

  if (existingItem) {
    throw createError(
      StatusCodes.CONFLICT,
      'Inventory item already exists for this composition',
    );
  }

  assertCreatePhotosPresent(input.photos);

  const inventoryAddress = await getUserInventoryAddress(user);
  await consumePersonalFallbackCodes(sellerIdentifier, user, components);

  let item: BoundaryItem;

  try {
    item = (await prismaInventory.$transaction(async (tx) => {
      const createdItem = await tx.item.create({
        data: {
          kind: input.kind,
          itemCode,
          sellerIdentifier,
          status: 'ACTIVE',
          addressLine1: inventoryAddress.line1 ?? null,
          addressLine2: inventoryAddress.line2 ?? null,
          addressCity: inventoryAddress.city ?? null,
          addressStateCode: inventoryAddress.stateCode ?? null,
          addressPostalCode: inventoryAddress.postalCode ?? null,
          addressCountryCode: inventoryAddress.countryCode ?? null,
          addressLatitude: inventoryAddress.latitude ?? null,
          addressLongitude: inventoryAddress.longitude ?? null,
        },
      });

      const resolvedLeaves = await Promise.all(
        components.map((component) => resolveComponentLeaf(tx, component)),
      );

      await tx.component.createMany({
        data: resolvedLeaves.map((resolvedLeaf, index) => ({
          itemId: createdItem.id,
          childType: resolvedLeaf.childType,
          instanceId: resolvedLeaf.instanceId,
          bundleId: resolvedLeaf.bundleId,
          componentSnapshot: buildStoredComponentSnapshot(components[index], resolvedLeaf),
          position: index,
        })),
      });

      if (input.kind === ItemKind.STOCK) {
        await syncStockItemQuantity(tx, createdItem.id, input.quantity as number);
      } else if (requestedCreateQuantity === 1) {
        await createMovement(
          tx,
          createdItem.id,
          MovementDirection.IN,
          MovementReason.STOCKED,
          1,
        );
      }

      await syncInventoryItemPhotos(
        tx,
        createdItem.id,
        createdItem.sellerIdentifier,
        input.photos,
        input.mainPhotoHash,
      );

      return tx.item.findUniqueOrThrow({
        where: { id: createdItem.id },
        include: itemBoundaryInclude,
      });
    })) as BoundaryItem;
  } catch (error) {
    await remapInstanceConstraintError(error, sellerIdentifier, components);
    throw error;
  }

  return {
    created: true,
    data: {
      resolvedInventoryItem: await buildInventoryResolution(item as BoundaryItem),
    },
  };
};

export const writeInventoryBoundary = async (
  user: AuthUserType,
  input: WriteInventoryBoundaryInput,
): Promise<InventoryBoundaryResult> => {
  const sellerIdentifier = user.accountIdentifier;
  if (!sellerIdentifier) {
    throw createError(StatusCodes.BAD_REQUEST, 'Seller required');
  }

  const components = normalizeInputComponents(input.components);
  assertInventorySnapshotSeller(sellerIdentifier, components);
  const itemCode = buildRequestedItemCode(components);
  const existingItem = (await findItemByCode(
    sellerIdentifier,
    itemCode,
  )) as BoundaryItem | null;

  if (!existingItem) {
    return createInventoryItemBoundary(user, {
      ...input,
      quantity: input.quantity ?? 1,
    });
  }

  if (existingItem.kind !== input.kind) {
    throw createError(
      StatusCodes.CONFLICT,
      'Inventory item already exists for this composition',
    );
  }

  const updateResult = await updateInventoryItemBoundary(user, existingItem.id, {
    ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
    photos: input.photos,
    mainPhotoHash: input.mainPhotoHash,
  });

  return {
    created: false,
    data: updateResult.data,
  };
};

export const updateInventoryItemBoundary = async (
  user: AuthUserType,
  itemId: number,
  input: UpdateInventoryItemBoundaryInput,
): Promise<InventoryUpdateResult> => {
  const sellerIdentifier = user.accountIdentifier;
  if (!sellerIdentifier) {
    throw createError(StatusCodes.BAD_REQUEST, 'Seller required');
  }

  const item = (await prismaInventory.item.findUnique({
    where: { id: itemId },
    include: itemBoundaryInclude,
  })) as BoundaryItem | null;

  if (!item || item.deletedAt) {
    throw createError(StatusCodes.NOT_FOUND, 'Inventory item not found');
  }

  if (item.sellerIdentifier !== sellerIdentifier) {
    throw createError(StatusCodes.FORBIDDEN, 'Inventory item seller invalid');
  }

  const shouldEmitImageUpdate =
    input.photos !== undefined || input.mainPhotoHash !== undefined;

  const { updatedItem, quantitySyncResult } = await prismaInventory.$transaction(async (tx) => {
    let quantitySyncResult: QuantitySyncResult | null = null;

    if (item.kind === ItemKind.LISTING) {
      if (input.quantity !== undefined) {
        quantitySyncResult = await syncListingItemQuantity(tx, item.id, input.quantity);
      }
    } else if (input.quantity !== undefined) {
      quantitySyncResult = await syncStockItemQuantity(tx, item.id, input.quantity);
    }

    if (input.photos !== undefined) {
      await syncInventoryItemPhotos(
        tx,
        item.id,
        item.sellerIdentifier,
        input.photos,
        input.mainPhotoHash,
      );
    } else if (input.mainPhotoHash !== undefined) {
      await syncInventoryItemMainPhotoSelection(tx, item.id, input.mainPhotoHash);
    }

    const updatedItem = await tx.item.findUniqueOrThrow({
      where: { id: item.id },
      include: itemBoundaryInclude,
    });

    return {
      updatedItem,
      quantitySyncResult,
    };
  });

  if (quantitySyncResult) {
    await notifyOffersOnZeroStock({
      sellerIdentifier: updatedItem.sellerIdentifier,
      itemCode: updatedItem.itemCode,
      direction: quantitySyncResult.direction,
      previousQuantity: quantitySyncResult.previousQuantity,
      nextQuantity: quantitySyncResult.nextQuantity,
      deduplicationKey: `movement:${quantitySyncResult.movementId}`,
    });
  }

  if (shouldEmitImageUpdate) {
    await notifyOffersOnImageUpdate(updatedItem as BoundaryItem);
  }

  return {
    data: {
      resolvedInventoryItem: await buildInventoryResolution(updatedItem as BoundaryItem),
    },
  };
};
