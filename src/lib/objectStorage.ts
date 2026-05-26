import AWS from 'aws-sdk';

export const INVENTORY_LISTING_PHOTO_USAGE = 'inventory-listing-photo' as const;
export const SUPPORTED_LISTING_PHOTO_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
export const LISTING_PHOTO_CHECKSUM_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

type CanonicalBlobKeyInput = {
  accountIdentifier: string;
  checksum: string;
  mimeType: string;
};

type ListingPhotoCanonicalObjectKeyInput = Pick<
  CanonicalBlobKeyInput,
  'accountIdentifier' | 'checksum'
>;

type ListingPhotoRawObjectKeyParts = {
  accountIdentifier: string;
  checksum: string;
  extension: string;
};

type ObjectStorageEnv = Partial<
  Record<
    | 'CELLIFI_AWS_ACCESS_KEY_ID'
    | 'CELLIFI_AWS_SECRET_ACCESS_KEY'
    | 'AWS_ACCESS_KEY_ID'
    | 'AWS_SECRET_ACCESS_KEY'
    | 'CELLIFI_AWS_REGION'
    | 'CLOUDFRONT_DOMAIN'
    | 'OBJECT_STORAGE_PUBLIC_BASE_URL'
    | 'PRIVATE_BUCKET_NAME'
    | 'S3_ENDPOINT',
    string
  >
>;

const trimToUndefined = (value?: string): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const stripTrailingSlashes = (value: string): string => value.replace(/\/+$/, '');

const normalizeMimeType = (mimeType: string): string => mimeType.trim().toLowerCase();

const splitMimeType = (mimeType: string) => {
  const [fileType, extension] = normalizeMimeType(mimeType).split('/');

  if (!fileType || !extension) {
    throw new Error(`Invalid mime type format: ${mimeType}`);
  }

  return { fileType, extension };
};

const resolveAwsCredentialValue = (
  explicitValue?: string,
  fallbackValue?: string
): string => {
  return trimToUndefined(explicitValue) || trimToUndefined(fallbackValue) || 'test';
};

export const resolveObjectStorageClientConfig = (
  env: ObjectStorageEnv = process.env
): AWS.S3.ClientConfiguration => {
  const region = trimToUndefined(env.CELLIFI_AWS_REGION) || 'us-east-1';
  const endpoint = trimToUndefined(env.S3_ENDPOINT);

  if (!endpoint) {
    return { region };
  }

  return {
    credentials: {
      accessKeyId: resolveAwsCredentialValue(
        env.CELLIFI_AWS_ACCESS_KEY_ID,
        env.AWS_ACCESS_KEY_ID
      ),
      secretAccessKey: resolveAwsCredentialValue(
        env.CELLIFI_AWS_SECRET_ACCESS_KEY,
        env.AWS_SECRET_ACCESS_KEY
      ),
    },
    endpoint,
    region,
    s3ForcePathStyle: true,
  };
};

export const createObjectStorageS3 = (
  env: ObjectStorageEnv = process.env
): AWS.S3 => {
  return new AWS.S3(resolveObjectStorageClientConfig(env));
};

export const isSupportedListingPhotoMimeType = (mimeType: string): boolean => {
  return SUPPORTED_LISTING_PHOTO_MIME_TYPES.includes(
    normalizeMimeType(mimeType) as (typeof SUPPORTED_LISTING_PHOTO_MIME_TYPES)[number]
  );
};

export const isValidListingPhotoChecksum = (checksum: string): boolean => {
  return LISTING_PHOTO_CHECKSUM_PATTERN.test(checksum.trim());
};

export const buildCanonicalBlobObjectKey = ({
  accountIdentifier,
  checksum,
  mimeType,
}: CanonicalBlobKeyInput): string => {
  const { fileType, extension } = splitMimeType(mimeType);
  return `products/${accountIdentifier}/${fileType}/${checksum}.${extension}`;
};

export const buildListingPhotoCanonicalObjectKey = ({
  accountIdentifier,
  checksum,
}: ListingPhotoCanonicalObjectKeyInput): string => {
  return buildCanonicalBlobObjectKey({
    accountIdentifier,
    checksum,
    mimeType: 'image/jpeg',
  });
};

export const buildListingPhotoRawObjectKey = ({
  accountIdentifier,
  checksum,
  mimeType,
}: CanonicalBlobKeyInput): string => {
  const { extension } = splitMimeType(mimeType);
  return `products/${accountIdentifier}/raw/${checksum}.${extension}`;
};

export const extractObjectKeyChecksum = (key: string): string => {
  return key.split('/').pop()?.split('.')[0] || '';
};

export const extractObjectKeyAccountIdentifier = (key: string): string => {
  return key.split('/')[1] || '';
};

export const parseListingPhotoRawObjectKey = (
  rawKey: string
): ListingPhotoRawObjectKeyParts | null => {
  const segments = rawKey.split('/');
  if (segments.length !== 4) {
    return null;
  }

  const [resource, accountIdentifier, segment, filename] = segments;
  if (
    resource !== 'products' ||
    segment !== 'raw' ||
    !accountIdentifier ||
    !filename
  ) {
    return null;
  }

  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === filename.length - 1) {
    return null;
  }

  const checksum = filename.slice(0, dotIndex);
  const extension = filename.slice(dotIndex + 1).toLowerCase();
  if (
    !isValidListingPhotoChecksum(checksum) ||
    !/^[a-z0-9]+$/i.test(extension)
  ) {
    return null;
  }

  return {
    accountIdentifier,
    checksum,
    extension,
  };
};

export const isListingPhotoRawObjectKey = (key: string): boolean => {
  return parseListingPhotoRawObjectKey(key) !== null;
};

export const buildListingPhotoCanonicalObjectKeyFromRaw = (
  rawKey: string
): string => {
  const rawKeyParts = parseListingPhotoRawObjectKey(rawKey);

  if (!rawKeyParts) {
    throw new Error(`Invalid listing photo raw key: ${rawKey}`);
  }

  return buildListingPhotoCanonicalObjectKey({
    accountIdentifier: rawKeyParts.accountIdentifier,
    checksum: rawKeyParts.checksum,
  });
};

export const resolveObjectPublicBaseUrl = (
  env: ObjectStorageEnv = process.env
): string => {
  const explicitBaseUrl = trimToUndefined(env.OBJECT_STORAGE_PUBLIC_BASE_URL);
  if (explicitBaseUrl) {
    return stripTrailingSlashes(explicitBaseUrl);
  }

  const endpoint = trimToUndefined(env.S3_ENDPOINT);
  const bucketName = trimToUndefined(env.PRIVATE_BUCKET_NAME);
  if (endpoint && bucketName) {
    return `${stripTrailingSlashes(endpoint)}/${bucketName}`;
  }

  const cdnDomain = trimToUndefined(env.CLOUDFRONT_DOMAIN);
  if (!cdnDomain) {
    throw new Error(
      'CLOUDFRONT_DOMAIN or OBJECT_STORAGE_PUBLIC_BASE_URL environment variable is required'
    );
  }

  if (/^https?:\/\//i.test(cdnDomain)) {
    return stripTrailingSlashes(cdnDomain);
  }

  return `https://${cdnDomain}`;
};

export const buildObjectPublicUrl = (
  key: string,
  env: ObjectStorageEnv = process.env
): string => {
  return `${resolveObjectPublicBaseUrl(env)}/${key}`;
};

export const buildRawObjectUrl = (
  bucketName: string,
  key: string,
  env: ObjectStorageEnv = process.env
): string => {
  const endpoint = trimToUndefined(env.S3_ENDPOINT);
  if (endpoint) {
    return `${stripTrailingSlashes(endpoint)}/${bucketName}/${key}`;
  }

  const region = trimToUndefined(env.CELLIFI_AWS_REGION) || 'us-east-1';
  return `https://${bucketName}.s3.${region}.amazonaws.com/${key.replace(/\s+/g, '+')}`;
};
