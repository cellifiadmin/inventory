import { describe, expect, it } from '@jest/globals';
import sharp from 'sharp';

import { normalizeListingPhotoImage } from '@/services/blobService/blobImageProcessor';

describe('blobImageProcessor', () => {
  it('normalizes landscape listing photo uploads to a cropped 768x1024 portrait jpeg', async () => {
    const transparentPngBuffer = await sharp({
      create: {
        width: 200,
        height: 100,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        {
          input: {
            create: {
              width: 100,
              height: 50,
              channels: 4,
              background: { r: 0, g: 0, b: 0, alpha: 1 },
            },
          },
          top: 25,
          left: 50,
        },
      ])
      .png()
      .toBuffer();

    const result = await normalizeListingPhotoImage({
      bytes: transparentPngBuffer,
      mimeType: 'image/png',
    });
    const outputMetadata = await sharp(result.outputBytes).metadata();
    const { data, info } = await sharp(result.outputBytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const readPixel = (x: number, y: number) => {
      const offset = (y * info.width + x) * info.channels;
      return Array.from(data.subarray(offset, offset + info.channels));
    };

    expect(result.outputMimeType).toBe('image/jpeg');
    expect(result.normalizedWidth).toBe(768);
    expect(result.normalizedHeight).toBe(1024);
    expect(result.strategy).toBe('cover-crop-portrait');
    expect(result.originalWidth).toBe(200);
    expect(result.originalHeight).toBe(100);
    expect(result.outputBytes.byteLength).toBeGreaterThan(0);
    expect(outputMetadata.format).toBe('jpeg');
    expect(outputMetadata.width).toBe(768);
    expect(outputMetadata.height).toBe(1024);
    expect(readPixel(10, 10)).toEqual([255, 255, 255, 255]);
    expect(readPixel(384, 512).slice(0, 3).every((value) => value < 32)).toBe(
      true,
    );
    expect(readPixel(384, 512)[3]).toBe(255);
  });

  it('always outputs exact portrait dimensions for non-portrait source images', async () => {
    const landscapeJpegBuffer = await sharp({
      create: {
        width: 1600,
        height: 900,
        channels: 3,
        background: { r: 80, g: 120, b: 160 },
      },
    })
      .jpeg()
      .toBuffer();

    const result = await normalizeListingPhotoImage({
      bytes: landscapeJpegBuffer,
      mimeType: 'image/jpeg',
    });
    const outputMetadata = await sharp(result.outputBytes).metadata();

    expect(result.normalizedWidth).toBe(768);
    expect(result.normalizedHeight).toBe(1024);
    expect(outputMetadata.width).toBe(768);
    expect(outputMetadata.height).toBe(1024);
  });

  it('center-crops landscape images to the portrait frame', async () => {
    const stripedLandscapeBuffer = await sharp({
      create: {
        width: 1200,
        height: 600,
        channels: 3,
        background: { r: 0, g: 255, b: 0 },
      },
    })
      .composite([
        {
          input: {
            create: {
              width: 300,
              height: 600,
              channels: 3,
              background: { r: 255, g: 0, b: 0 },
            },
          },
          top: 0,
          left: 0,
        },
        {
          input: {
            create: {
              width: 300,
              height: 600,
              channels: 3,
              background: { r: 0, g: 0, b: 255 },
            },
          },
          top: 0,
          left: 900,
        },
      ])
      .png()
      .toBuffer();

    const result = await normalizeListingPhotoImage({
      bytes: stripedLandscapeBuffer,
      mimeType: 'image/png',
    });
    const { data, info } = await sharp(result.outputBytes)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const readPixel = (x: number, y: number) => {
      const offset = (y * info.width + x) * info.channels;
      return Array.from(data.subarray(offset, offset + info.channels));
    };

    expect(readPixel(0, 512)).toEqual([0, 255, 1]);
    expect(readPixel(767, 512)).toEqual([0, 255, 1]);
  });

  it('accepts supported image mime types regardless of letter casing', async () => {
    const pngBuffer = await sharp({
      create: {
        width: 100,
        height: 200,
        channels: 3,
        background: { r: 10, g: 20, b: 30 },
      },
    })
      .png()
      .toBuffer();

    const result = await normalizeListingPhotoImage({
      bytes: pngBuffer,
      mimeType: 'Image/PNG',
    });

    expect(result.outputMimeType).toBe('image/jpeg');
    expect(result.normalizedWidth).toBe(768);
    expect(result.normalizedHeight).toBe(1024);
  });

  it('rejects unsupported image mime types with a clear error', async () => {
    await expect(
      normalizeListingPhotoImage({
        bytes: Buffer.from('not-an-image'),
        mimeType: 'image/heic',
      }),
    ).rejects.toMatchObject({
      message: 'Unsupported image mime type: image/heic',
      statusCode: 415,
    });
  });

  it('rejects unreadable image bytes with a bad-request http error', async () => {
    await expect(
      normalizeListingPhotoImage({
        bytes: Buffer.from('not-an-image'),
        mimeType: 'image/png',
      }),
    ).rejects.toMatchObject({
      message: 'Invalid image payload',
      statusCode: 400,
    });
  });

  it('rejects empty image payloads with a bad-request http error', async () => {
    await expect(
      normalizeListingPhotoImage({
        bytes: Buffer.alloc(0),
        mimeType: 'image/png',
      }),
    ).rejects.toMatchObject({
      message: 'Invalid image payload',
      statusCode: 400,
    });
  });

  it('rejects corrupt image payloads with a bad-request http error', async () => {
    const validPngBuffer = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: { r: 40, g: 50, b: 60 },
      },
    })
      .png()
      .toBuffer();
    const corruptPngBuffer = Buffer.concat([
      validPngBuffer.subarray(0, 8),
      Buffer.from('corrupt-payload'),
    ]);

    await expect(
      normalizeListingPhotoImage({
        bytes: corruptPngBuffer,
        mimeType: 'image/png',
      }),
    ).rejects.toMatchObject({
      message: 'Invalid image payload',
      statusCode: 400,
    });
  });

  it('rejects corrupt jpeg payloads with a bad-request http error', async () => {
    const validJpegBuffer = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: { r: 120, g: 80, b: 40 },
      },
    })
      .jpeg()
      .toBuffer();
    const corruptJpegBuffer = Buffer.concat([
      validJpegBuffer.subarray(0, 4),
      Buffer.from('corrupt-jpeg-payload'),
    ]);

    await expect(
      normalizeListingPhotoImage({
        bytes: corruptJpegBuffer,
        mimeType: 'image/jpeg',
      }),
    ).rejects.toMatchObject({
      message: 'Invalid image payload',
      statusCode: 400,
    });
  });

  it('rejects corrupt webp payloads with a bad-request http error', async () => {
    const validWebpBuffer = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: { r: 90, g: 110, b: 130 },
      },
    })
      .webp()
      .toBuffer();
    const corruptWebpBuffer = Buffer.concat([
      validWebpBuffer.subarray(0, 12),
      Buffer.from('corrupt-webp-payload'),
    ]);

    await expect(
      normalizeListingPhotoImage({
        bytes: corruptWebpBuffer,
        mimeType: 'image/webp',
      }),
    ).rejects.toMatchObject({
      message: 'Invalid image payload',
      statusCode: 400,
    });
  });

  it('rejects png payloads with a missing IHDR chunk as bad-request errors', async () => {
    const validPngBuffer = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: { r: 20, g: 30, b: 40 },
      },
    })
      .png()
      .toBuffer();
    const missingIhdrPngBuffer = Buffer.from(validPngBuffer);
    missingIhdrPngBuffer.write('IDAT', 12, 'ascii');

    await expect(
      normalizeListingPhotoImage({
        bytes: missingIhdrPngBuffer,
        mimeType: 'image/png',
      }),
    ).rejects.toMatchObject({
      message: 'Invalid image payload',
      statusCode: 400,
    });
  });

  it('reports original dimensions after auto-orientation when EXIF orientation is present', async () => {
    const rotatedJpegBuffer = await sharp({
      create: {
        width: 40,
        height: 80,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const result = await normalizeListingPhotoImage({
      bytes: rotatedJpegBuffer,
      mimeType: 'image/jpeg',
    });

    expect(result.originalWidth).toBe(80);
    expect(result.originalHeight).toBe(40);
  });
});
