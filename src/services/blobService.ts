import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';

import prismaInventory from '@/lib/prismaInventory';
import {
  buildRawObjectUrl,
  createObjectStorageS3,
  INVENTORY_LISTING_PHOTO_USAGE,
} from '@/lib/objectStorage';
import { assertOwnedInventoryPhotoAssetRef } from '@/inventory/services/itemImageService';
import type { AuthUserType } from '@/types/userType';

const PRIVATE_BUCKET_NAME = process.env.PRIVATE_BUCKET_NAME as string;
const getSigningS3 = () => createObjectStorageS3();

type CreateBlobInput = {
  key: string;
  name?: string | null | undefined;
  checksum?: string | null | undefined;
  mimeType?: string | null | undefined;
  size?: number | null | undefined;
  assetRef?: string | null | undefined;
  usage?: typeof INVENTORY_LISTING_PHOTO_USAGE;
};

type GetBlobInput = {
  key: string;
};

type BlobPersistenceInput = {
  key: string;
  checksum: string;
  assetRef: string;
  mimeType: string;
  size: number;
  name?: string | null | undefined;
  metadata: Record<string, unknown>;
};

const isPrismaUniqueConstraintError = (error: any) => error?.code === 'P2002';

const parseMimeType = (mimeType: string) => {
  if (!mimeType.includes('/')) {
    throw createError(StatusCodes.BAD_REQUEST, 'Invalid ContentType format');
  }

  const [fileType, extension] = mimeType.toLowerCase().split('/');
  return { fileType, extension };
};

const getBlobName = (
  checksum: string,
  extension: string,
  name?: string | null,
) => name || `${checksum}.${extension}`;

const persistBlobRecord = async (input: BlobPersistenceInput) => {
  const { key, checksum, assetRef, mimeType, size, name, metadata } = input;
  const existingAssetBlob = await prismaInventory.blob.findUnique({
    where: { assetRef },
  });
  if (existingAssetBlob) {
    return existingAssetBlob;
  }

  const { fileType, extension } = parseMimeType(mimeType);

  try {
    return await prismaInventory.blob.create({
      data: {
        key,
        checksum,
        assetRef,
        url: buildRawObjectUrl(PRIVATE_BUCKET_NAME, key),
        size,
        metadata,
        name: getBlobName(checksum, extension, name),
        extension,
        fileType,
      },
    });
  } catch (error) {
    if (!isPrismaUniqueConstraintError(error)) {
      throw error;
    }

    const racedBlob = await prismaInventory.blob.findUnique({
      where: { assetRef },
    });
    if (racedBlob) {
      return racedBlob;
    }

    throw error;
  }
};

const createCentralizedListingPhotoBlob = async (
  user: AuthUserType,
  input: CreateBlobInput,
) => {
  const { key, name, checksum, mimeType, size, assetRef } = input;

  if (!assetRef || !checksum || !mimeType || typeof size !== 'number') {
    throw createError(StatusCodes.BAD_REQUEST, 'Photo upload incomplete');
  }

  if (!user.accountIdentifier) {
    throw createError(StatusCodes.BAD_REQUEST, 'Photo invalid');
  }

  assertOwnedInventoryPhotoAssetRef(assetRef, user.accountIdentifier);

  return persistBlobRecord({
    key,
    checksum,
    assetRef,
    mimeType,
    size,
    metadata: {
      usage: INVENTORY_LISTING_PHOTO_USAGE,
      source: 'media',
    },
    name,
  });
};

export const createBlob = async (
  user: AuthUserType,
  input: CreateBlobInput,
) => {
  if (input.usage !== INVENTORY_LISTING_PHOTO_USAGE) {
    throw createError(
      StatusCodes.BAD_REQUEST,
      'Only centralized listing photo uploads are supported.',
    );
  }

  return createCentralizedListingPhotoBlob(user, input);
};

export const getBlob = async (_user: AuthUserType, input: GetBlobInput) => {
  const blob = await prismaInventory.blob.findFirst({
    where: { key: input.key },
  });

  if (!blob) {
    throw createError(StatusCodes.NOT_FOUND, 'Blob not found in database');
  }

  return blob;
};

export const generateDownloadUrl = async (blob: any) => {
  const filename = `${blob.name || 'file'}.${blob.extension || 'bin'}`;
  return getSigningS3().getSignedUrl('getObject', {
    Bucket: PRIVATE_BUCKET_NAME,
    Key: blob.key,
    ResponseContentDisposition: `attachment; filename="${filename}"`,
  }, { expiresIn: 60 * 5 });
};

export const generatePreviewUrl = async (blob: any) => {
  return getSigningS3().getSignedUrl('getObject', {
    Bucket: PRIVATE_BUCKET_NAME,
    Key: blob.key,
    ResponseContentDisposition: `inline; filename="${blob.name}"`,
  }, { expiresIn: 60 * 5 });
};
