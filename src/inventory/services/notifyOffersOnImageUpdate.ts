import { enqueueOffersImageSync } from '@/services/offersStockSyncQueue';
import { blobKeyToCDNUrl } from '@/services/blobService/getCDNUrl';

type InventoryItemImageSyncBlob = {
  id: number;
  checksum: string;
  key: string;
  name: string;
  size: number | null;
  fileType: string;
  extension: string;
  assetRef?: string | null;
};

type InventoryItemImageSyncAttachment = {
  blob: InventoryItemImageSyncBlob;
};

export type InventoryItemImageSyncState = {
  id: number;
  sellerIdentifier: string;
  itemCode: string;
  mainImage: InventoryItemImageSyncAttachment | null;
  images: InventoryItemImageSyncAttachment[];
};

export const inventoryItemImageRelationsInclude = {
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

const buildImagePayloadPhoto = (
  attachment: InventoryItemImageSyncAttachment,
) => ({
  blobId: attachment.blob.id,
  checksum: attachment.blob.checksum,
  key: attachment.blob.key,
  name: attachment.blob.name,
  mimeType: attachment.blob.extension
    ? `${attachment.blob.fileType}/${attachment.blob.extension}`
    : attachment.blob.fileType,
  size: attachment.blob.size ?? 0,
  assetRef: attachment.blob.assetRef ?? null,
  cdnUrl: blobKeyToCDNUrl(attachment.blob.key),
});

const buildDeduplicationKey = (
  item: InventoryItemImageSyncState,
) => {
  const mainPhotoChecksum = item.mainImage?.blob.checksum ?? 'none';
  const photoChecksums = item.images.map((attachment) => attachment.blob.checksum);

  return `item:${item.id}:main:${mainPhotoChecksum}:photos:${photoChecksums.join(',') || 'none'}`;
};

export const notifyOffersOnImageUpdate = async (
  item: InventoryItemImageSyncState,
) => {
  const mainPhoto = item.mainImage
    ? buildImagePayloadPhoto(item.mainImage)
    : null;
  const photos = item.images.map((attachment) => buildImagePayloadPhoto(attachment));

  const message = {
    eventType: 'IMAGES_UPDATED' as const,
    sellerIdentifier: item.sellerIdentifier,
    itemCode: item.itemCode,
    mainPhoto,
    photos,
  };

  await enqueueOffersImageSync(message, {
    deduplicationKey: buildDeduplicationKey(item),
  });
};
