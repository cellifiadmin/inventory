import { describe, expect, it, jest } from '@jest/globals';

import {
  assertOwnedInventoryPhotoAssetRef,
  buildInventorySnapshotPhoto,
  resolveInventoryPhotoBlobs,
} from '@/inventory/services/itemImageService';

describe('itemImageService', () => {
  it('accepts listing-draft asset refs that belong to the current seller account', () => {
    expect(() =>
      assertOwnedInventoryPhotoAssetRef(
        'inventory/items/acct-1/listing-photo/abc123',
        'acct-1',
      ),
    ).not.toThrow();
  });

  it('rejects listing-draft asset refs owned by a different seller account', () => {
    expect(() =>
      assertOwnedInventoryPhotoAssetRef(
        'inventory/items/acct-2/listing-photo/abc123',
        'acct-1',
      ),
    ).toThrow('Photo invalid');
  });

  it('builds snapshot photos with both assetRef and cdnUrl preserved', () => {
    expect(
      buildInventorySnapshotPhoto({
        blob: {
          id: 91,
          checksum: 'photo-a',
          key: 'media/image/photo-a/inventory-listing-photo-v1.jpeg',
          name: 'photo-a-original.png',
          size: 1024,
          fileType: 'image',
          extension: 'jpeg',
          assetRef: 'inventory/items/acct-1/listing-photo/photo-a',
        },
      }),
    ).toEqual(
      expect.objectContaining({
        blobId: 91,
        checksum: 'photo-a',
        key: 'media/image/photo-a/inventory-listing-photo-v1.jpeg',
        name: 'photo-a-original.png',
        mimeType: 'image/jpeg',
        size: 1024,
        assetRef: 'inventory/items/acct-1/listing-photo/photo-a',
        cdnUrl: expect.stringContaining(
          '/media/image/photo-a/inventory-listing-photo-v1.jpeg',
        ),
      }),
    );
  });

  it('creates a blob row from finalized media metadata when no inventory blob id exists yet', async () => {
    const createCalls: Array<Record<string, unknown>> = [];
    const tx = {
      blob: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(async ({ data }) => {
          createCalls.push(data);
          return {
            id: 77,
            checksum: data.checksum,
            key: data.key,
            assetRef: data.assetRef,
          };
        }),
      },
    };

    await expect(
      resolveInventoryPhotoBlobs(tx, 'acct-1', [
        {
          checksum: 'photo-c',
          assetRef: 'inventory/items/acct-1/listing-photo/photo-c',
          key: 'media/image/photo-c/original.jpeg',
          name: 'photo-c.jpg',
          mimeType: 'image/jpeg',
          size: 2048,
        },
      ]),
    ).resolves.toEqual([
      {
        id: 77,
        checksum: 'photo-c',
        key: 'media/image/photo-c/original.jpeg',
        assetRef: 'inventory/items/acct-1/listing-photo/photo-c',
      },
    ]);

    expect(tx.blob.findMany).toHaveBeenCalledTimes(1);
    expect(tx.blob.create).toHaveBeenCalledTimes(1);
    expect(createCalls[0]).toEqual(
      expect.objectContaining({
        key: 'media/image/photo-c/original.jpeg',
        checksum: 'photo-c',
        assetRef: 'inventory/items/acct-1/listing-photo/photo-c',
        size: 2048,
        name: 'photo-c.jpg',
      }),
    );
  });

  it('reuses the raced assetRef row when blob persistence hits a uniqueness conflict', async () => {
    const tx = {
      blob: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockRejectedValue({ code: 'P2002' }),
        findFirst: jest.fn().mockResolvedValue({
          id: 88,
          checksum: 'photo-race',
          key: 'media/image/photo-race/original.jpeg',
          assetRef: 'inventory/items/acct-1/listing-photo/photo-race',
        }),
      },
    };

    await expect(
      resolveInventoryPhotoBlobs(tx, 'acct-1', [
        {
          checksum: 'photo-race',
          assetRef: 'inventory/items/acct-1/listing-photo/photo-race',
          key: 'media/image/photo-race/original.jpeg',
          name: 'photo-race.jpg',
          mimeType: 'image/jpeg',
          size: 4096,
        },
      ]),
    ).resolves.toEqual([
      {
        id: 88,
        checksum: 'photo-race',
        key: 'media/image/photo-race/original.jpeg',
        assetRef: 'inventory/items/acct-1/listing-photo/photo-race',
      },
    ]);

    expect(tx.blob.create).toHaveBeenCalledTimes(1);
    expect(tx.blob.findFirst).toHaveBeenCalledWith({
      where: {
        assetRef: 'inventory/items/acct-1/listing-photo/photo-race',
      },
    });
  });

  it('rejects newly uploaded photo metadata when assetRef is missing', async () => {
    const tx = {
      blob: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
      },
    };

    await expect(
      resolveInventoryPhotoBlobs(tx, 'acct-1', [
        {
          checksum: 'photo-d',
          key: 'media/image/photo-d/original.jpeg',
          name: 'photo-d.jpg',
          mimeType: 'image/jpeg',
          size: 1024,
        },
      ]),
    ).rejects.toThrow('Photo invalid');
  });
});
