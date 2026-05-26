import { StatusCodes } from 'http-status-codes';
import sharp from 'sharp';

export const LISTING_PHOTO_CANONICAL_IMAGE_WIDTH = 768;
export const LISTING_PHOTO_CANONICAL_IMAGE_HEIGHT = 1024;
const OUTPUT_MIME_TYPE = 'image/jpeg';
export const LISTING_PHOTO_NORMALIZATION_STRATEGY = 'cover-crop-portrait';
const WHITE_BACKGROUND = { r: 255, g: 255, b: 255, alpha: 1 };
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const INVALID_IMAGE_PAYLOAD_FRAGMENTS = [
  'unsupported image format',
  'premature end of input file',
  'corrupt jpeg',
  'corrupt header',
  'invalid image',
  'input buffer is empty',
  'bad seek',
  'end of stream',
];
type HttpErrorLike = Error & {
  expose?: boolean;
  status?: number;
  statusCode: number;
};

type CreateErrorModule = ((status: number, message?: string) => HttpErrorLike) & {
  isHttpError: (error: unknown) => error is HttpErrorLike;
};

const createError = require('http-errors') as CreateErrorModule;
const { isHttpError } = createError;

export interface NormalizeListingPhotoImageInput {
  bytes: Buffer;
  mimeType: string;
}

export interface NormalizeListingPhotoImageResult {
  outputBytes: Buffer;
  outputMimeType: typeof OUTPUT_MIME_TYPE;
  normalizedWidth: typeof LISTING_PHOTO_CANONICAL_IMAGE_WIDTH;
  normalizedHeight: typeof LISTING_PHOTO_CANONICAL_IMAGE_HEIGHT;
  strategy: typeof LISTING_PHOTO_NORMALIZATION_STRATEGY;
  originalWidth: number;
  originalHeight: number;
}

const getAutoOrientedDimensions = (metadata: sharp.Metadata) => {
  const { width, height, orientation } = metadata;

  if (!width || !height) {
    return { width: 0, height: 0 };
  }

  if (orientation && [5, 6, 7, 8].includes(orientation)) {
    return {
      width: height,
      height: width,
    };
  }

  return { width, height };
};

const isInvalidImagePayloadError = (error: unknown) => {
  if (isHttpError(error) || !(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return INVALID_IMAGE_PAYLOAD_FRAGMENTS.some((fragment) =>
    message.includes(fragment),
  );
};

export const normalizeListingPhotoImage = async (
  input: NormalizeListingPhotoImageInput,
): Promise<NormalizeListingPhotoImageResult> => {
  const normalizedMimeType = input.mimeType.toLowerCase();

  if (!SUPPORTED_IMAGE_MIME_TYPES.has(normalizedMimeType)) {
    throw createError(
      StatusCodes.UNSUPPORTED_MEDIA_TYPE,
      `Unsupported image mime type: ${input.mimeType}`,
    );
  }

  try {
    const transformer = sharp(input.bytes, { failOn: 'error' });
    const imageMetadata = await transformer.metadata();
    const originalDimensions = getAutoOrientedDimensions(imageMetadata);

    if (!originalDimensions.width || !originalDimensions.height) {
      throw createError(StatusCodes.BAD_REQUEST, 'Invalid image payload');
    }

    const { data: outputBytes, info } = await transformer
      .rotate()
      .flatten({ background: WHITE_BACKGROUND })
      .resize(
        LISTING_PHOTO_CANONICAL_IMAGE_WIDTH,
        LISTING_PHOTO_CANONICAL_IMAGE_HEIGHT,
        {
        fit: 'cover',
        position: 'centre',
        },
      )
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

    if (
      info.width !== LISTING_PHOTO_CANONICAL_IMAGE_WIDTH ||
      info.height !== LISTING_PHOTO_CANONICAL_IMAGE_HEIGHT
    ) {
      throw createError(
        StatusCodes.INTERNAL_SERVER_ERROR,
        'Image normalization produced unexpected dimensions',
      );
    }

    return {
      outputBytes,
      outputMimeType: OUTPUT_MIME_TYPE,
      normalizedWidth: LISTING_PHOTO_CANONICAL_IMAGE_WIDTH,
      normalizedHeight: LISTING_PHOTO_CANONICAL_IMAGE_HEIGHT,
      strategy: LISTING_PHOTO_NORMALIZATION_STRATEGY,
      originalWidth: originalDimensions.width,
      originalHeight: originalDimensions.height,
    };
  } catch (error) {
    if (isHttpError(error)) {
      throw error;
    }

    if (isInvalidImagePayloadError(error)) {
      throw createError(StatusCodes.BAD_REQUEST, 'Invalid image payload');
    }

    throw error;
  }
};
