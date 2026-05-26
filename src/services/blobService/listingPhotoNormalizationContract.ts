import { StatusCodes } from 'http-status-codes';
import createError from 'http-errors';

import { INVENTORY_LISTING_PHOTO_USAGE } from '@/lib/objectStorage';
import {
  LISTING_PHOTO_CANONICAL_IMAGE_HEIGHT,
  LISTING_PHOTO_CANONICAL_IMAGE_WIDTH,
  LISTING_PHOTO_NORMALIZATION_STRATEGY,
  NormalizeListingPhotoImageResult,
} from '@/services/blobService/blobImageProcessor';

export const LISTING_PHOTO_NORMALIZATION_VERSION = 2;
export const LISTING_PHOTO_NORMALIZED_MIME_TYPE = 'image/jpeg' as const;

export const isListingPhotoBlobMetadataCompliant = (metadata: unknown) => {
  if (!metadata || typeof metadata !== 'object') {
    return false;
  }

  const record = metadata as Record<string, unknown>;

  return (
    record.usage === INVENTORY_LISTING_PHOTO_USAGE &&
    record.normalizationVersion === LISTING_PHOTO_NORMALIZATION_VERSION &&
    typeof record.originalMimeType === 'string' &&
    record.originalMimeType.length > 0 &&
    typeof record.originalWidth === 'number' &&
    record.originalWidth > 0 &&
    typeof record.originalHeight === 'number' &&
    record.originalHeight > 0 &&
    record.normalizedMimeType === LISTING_PHOTO_NORMALIZED_MIME_TYPE &&
    record.normalizedWidth === LISTING_PHOTO_CANONICAL_IMAGE_WIDTH &&
    record.normalizedHeight === LISTING_PHOTO_CANONICAL_IMAGE_HEIGHT &&
    record.strategy === LISTING_PHOTO_NORMALIZATION_STRATEGY
  );
};

export const assertListingPhotoNormalizationContract = (
  normalizedImage: NormalizeListingPhotoImageResult,
) => {
  if (
    normalizedImage.outputMimeType !== LISTING_PHOTO_NORMALIZED_MIME_TYPE ||
    normalizedImage.normalizedWidth !== LISTING_PHOTO_CANONICAL_IMAGE_WIDTH ||
    normalizedImage.normalizedHeight !== LISTING_PHOTO_CANONICAL_IMAGE_HEIGHT ||
    normalizedImage.strategy !== LISTING_PHOTO_NORMALIZATION_STRATEGY
  ) {
    throw createError(
      StatusCodes.INTERNAL_SERVER_ERROR,
      'Unexpected listing photo normalization contract',
    );
  }
};
