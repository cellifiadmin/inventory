import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';

import { buildRawObjectUrl } from '@/lib/objectStorage';
import { blobKeyToCDNUrl } from '@/services/blobService/getCDNUrl';
import {
  INVENTORY_MEDIA_DOMAIN,
  INVENTORY_MEDIA_ITEMS_RESOURCE,
  INVENTORY_MEDIA_LISTING_PHOTO_USAGE,
} from '@/services/media/mediaGrantService';

type AssetRefParts = {
  domain: string;
  resource: string;
  resourceKey: string;
  usage: string;
  assetKey: string;
};

export type InventoryPhotoInput = {
  blobId?: number;
  checksum: string;
  assetRef?: string;
  key?: string;
  name?: string;
  mimeType?: string;
  size?: number;
};

type InventoryBlobLike = {
  id: number;
  checksum: string;
  key: string;
  name: string;
  size: number | null;
  fileType: string;
  extension: string;
  assetRef?: string | null;
};

type InventoryAttachmentLike = {
  blob: InventoryBlobLike;
};

type InventoryBlobRecord = {
  id: number;
  checksum: string;
  key: string;
  assetRef?: string | null;
};

const isPrismaUniqueConstraintError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: string }).code === 'P2002';

const parseAssetRef = (assetRef: string): AssetRefParts | null => {
  const segments = assetRef
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length !== 5) {
    return null;
  }

  const [domain, resource, resourceKey, usage, assetKey] = segments;
  if (!domain || !resource || !resourceKey || !usage || !assetKey) {
    return null;
  }

  return {
    domain,
    resource,
    resourceKey,
    usage,
    assetKey,
  };
};

export const assertOwnedInventoryPhotoAssetRef = (
  assetRef: string,
  sellerIdentifier: string,
) => {
  const parts = parseAssetRef(assetRef);

  if (
    !parts ||
    parts.domain !== INVENTORY_MEDIA_DOMAIN ||
    parts.resource !== INVENTORY_MEDIA_ITEMS_RESOURCE ||
    parts.resourceKey !== sellerIdentifier ||
    parts.usage !== INVENTORY_MEDIA_LISTING_PHOTO_USAGE
  ) {
    throw createError(StatusCodes.BAD_REQUEST, 'Photo invalid');
  }
};

const assertCentralizedInventoryPhotoInput = (
  photo: InventoryPhotoInput,
  sellerIdentifier: string,
) => {
  if (typeof photo.blobId === 'number') {
    return;
  }

  if (!photo.assetRef || !photo.key) {
    throw createError(StatusCodes.BAD_REQUEST, 'Photo invalid');
  }

  assertOwnedInventoryPhotoAssetRef(photo.assetRef, sellerIdentifier);
};

const assertOwnedInventoryBlobRecord = (
  blob: InventoryBlobRecord | InventoryBlobLike,
  sellerIdentifier: string,
) => {
  if (!blob.assetRef) {
    throw createError(StatusCodes.BAD_REQUEST, 'Photo invalid');
  }

  assertOwnedInventoryPhotoAssetRef(blob.assetRef, sellerIdentifier);
};

const persistInventoryBlobFromMetadata = async (
  tx: any,
  photo: InventoryPhotoInput & { key: string; assetRef: string },
) => {
  const keyParts = photo.key.split('/');
  const filename = keyParts[keyParts.length - 1];
  const extension = filename.split('.').pop() || 'jpg';
  const mimeType = photo.mimeType || `image/${extension}`;
  const [fileType] = mimeType.split('/');

  try {
    return await tx.blob.create({
      data: {
        key: photo.key,
        checksum: photo.checksum,
        assetRef: photo.assetRef,
        url: buildRawObjectUrl(process.env.PRIVATE_BUCKET_NAME as string, photo.key),
        size: photo.size || 0,
        metadata: {},
        name: photo.name || filename,
        extension,
        fileType,
      },
    });
  } catch (error) {
    if (!isPrismaUniqueConstraintError(error)) {
      throw error;
    }

    const racedBlob = await tx.blob.findFirst({
      where: {
        assetRef: photo.assetRef,
      },
    });

    if (racedBlob) {
      return racedBlob;
    }

    throw error;
  }
};

export const resolveInventoryPhotoBlobs = async (
  tx: any,
  sellerIdentifier: string,
  photos: InventoryPhotoInput[],
): Promise<InventoryBlobRecord[]> => {
  if (photos.length === 0) {
    return [];
  }

  const photoBlobIds = photos.flatMap((photo) =>
    typeof photo.blobId === 'number' ? [photo.blobId] : [],
  );
  const photoAssetRefs = photos.flatMap((photo) => {
    assertCentralizedInventoryPhotoInput(photo, sellerIdentifier);
    return photo.assetRef ? [photo.assetRef] : [];
  });

  const existingBlobs = await tx.blob.findMany({
    where: {
      OR: [
        ...(photoBlobIds.length > 0
          ? [
              {
                id: {
                  in: photoBlobIds,
                },
              },
            ]
          : []),
        ...(photoAssetRefs.length > 0
          ? [
              {
                assetRef: {
                  in: photoAssetRefs,
                },
              },
            ]
          : []),
      ],
    },
    select: {
      id: true,
      checksum: true,
      key: true,
      assetRef: true,
    },
  });

  const existingById = new Map(existingBlobs.map((blob) => [blob.id, blob] as const));
  const existingByAssetRef = new Map(
    existingBlobs
      .filter((blob) => typeof blob.assetRef === 'string' && blob.assetRef.length > 0)
      .map((blob) => [blob.assetRef as string, blob] as const),
  );

  const resolvedBlobs: InventoryBlobRecord[] = [];

  for (const photo of photos) {
    const existingBlob =
      (typeof photo.blobId === 'number'
        ? existingById.get(photo.blobId)
        : undefined) ||
      (photo.assetRef ? existingByAssetRef.get(photo.assetRef) : undefined);

    if (existingBlob) {
      assertOwnedInventoryBlobRecord(existingBlob, sellerIdentifier);
      resolvedBlobs.push(existingBlob);
      continue;
    }

    assertCentralizedInventoryPhotoInput(photo, sellerIdentifier);

    const createdBlob = await persistInventoryBlobFromMetadata(
      tx,
      photo as InventoryPhotoInput & { key: string; assetRef: string },
    );
    assertOwnedInventoryBlobRecord(createdBlob, sellerIdentifier);

    const normalizedCreatedBlob = {
      id: createdBlob.id,
      checksum: createdBlob.checksum,
      key: createdBlob.key,
      assetRef: createdBlob.assetRef ?? null,
    };

    existingById.set(normalizedCreatedBlob.id, normalizedCreatedBlob);
    if (normalizedCreatedBlob.assetRef) {
      existingByAssetRef.set(
        normalizedCreatedBlob.assetRef,
        normalizedCreatedBlob,
      );
    }

    resolvedBlobs.push(normalizedCreatedBlob);
  }

  return resolvedBlobs;
};

export const buildInventorySnapshotPhoto = (
  attachment: InventoryAttachmentLike,
) => ({
  blobId: attachment.blob.id,
  checksum: attachment.blob.checksum,
  key: attachment.blob.key,
  name: attachment.blob.name || null,
  mimeType: attachment.blob.extension
    ? `${attachment.blob.fileType}/${attachment.blob.extension}`
    : attachment.blob.fileType,
  size: attachment.blob.size ?? 0,
  assetRef: attachment.blob.assetRef ?? null,
  cdnUrl: blobKeyToCDNUrl(attachment.blob.key),
});
