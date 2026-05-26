import { describe, expect, it } from '@jest/globals';

import {
  validateCreateInventoryItemInput,
  validateUpdateInventoryItemInput,
  validateWriteInventoryItemInput,
} from '@/inventory/validation/validateCreateInventoryItemInput';
import type { AuthUserType } from '@/types/userType';

const buildListingPayload = () => ({
  kind: 'LISTING',
  components: [
    {
      sku: 'SKU-1',
      count: 1,
      productType: 'PHONE',
      imei: '354210975944783',
      productSnapshot: {
        sellerIdentifier: 'seller-1',
        sku: 'SKU-1',
        batteryLevel: 90,
        brand: { key: 'APL', name: 'Apple' },
        model: { key: 'IP16', name: 'iPhone 16' },
        color: { key: 'BLK', name: 'Black', hexValue: '#000000' },
        storage: { key: '12', name: '128GB' },
        condition: { key: 'EXC', label: 'Excellent' },
        carrier: null,
      },
    },
  ],
  photos: [],
});

describe('validateCreateInventoryItemInput', () => {
  it('accepts component-level imei on LISTING payloads', () => {
    const result = validateCreateInventoryItemInput(buildListingPayload());

    expect(result.components[0]).toEqual(
      expect.objectContaining({
        count: 1,
        imei: '354210975944783',
      }),
    );
  });

  it('rejects top-level identifier on inventory payloads', () => {
    expect(() =>
      validateCreateInventoryItemInput({
        ...buildListingPayload(),
        identifier: '354210975944783',
      }),
    ).toThrow();
  });

  it('rejects top-level fallbackCode on inventory payloads', () => {
    expect(() =>
      validateCreateInventoryItemInput({
        ...buildListingPayload(),
        fallbackCode: 'encrypted-fallback-code',
      }),
    ).toThrow();
  });

  it('accepts component-level fallbackCode', () => {
    const result = validateCreateInventoryItemInput({
      kind: 'LISTING',
      components: [
        {
          sku: 'SKU-1',
          count: 1,
          productType: 'PHONE',
          fallbackCode: 'encrypted-fallback-code',
          productSnapshot: {
            sellerIdentifier: 'seller-1',
            sku: 'SKU-1',
            batteryLevel: 90,
            brand: { key: 'APL', name: 'Apple' },
            model: { key: 'IP16', name: 'iPhone 16' },
            color: { key: 'BLK', name: 'Black', hexValue: '#000000' },
            storage: { key: '12', name: '128GB' },
            condition: { key: 'EXC', label: 'Excellent' },
            carrier: null,
          },
        },
      ],
      photos: [],
    });

    expect(result.components[0]).toEqual(
      expect.objectContaining({
        count: 1,
        fallbackCode: 'encrypted-fallback-code',
      }),
    );
  });

  it('accepts bundle-style components that omit both imei and fallbackCode', () => {
    const result = validateCreateInventoryItemInput({
      kind: 'LISTING',
      components: [
        {
          sku: 'SKU-1',
          count: 3,
          productType: 'PHONE',
          productSnapshot: {
            sellerIdentifier: 'seller-1',
            sku: 'SKU-1',
            batteryLevel: 90,
            brand: { key: 'APL', name: 'Apple' },
            model: { key: 'IP16', name: 'iPhone 16' },
            color: { key: 'BLK', name: 'Black', hexValue: '#000000' },
            storage: { key: '12', name: '128GB' },
            condition: { key: 'EXC', label: 'Excellent' },
            carrier: null,
          },
        },
      ],
      photos: [],
    });

    expect(result.components[0]).toEqual(
      expect.objectContaining({
        count: 3,
      }),
    );
  });

  it('accepts LISTING payloads with mixed instance and bundle components', () => {
    const result = validateCreateInventoryItemInput({
      ...buildListingPayload(),
      components: [
        buildListingPayload().components[0],
        {
          sku: 'SKU-2',
          count: 3,
          productType: 'ACCESSORY',
          productSnapshot: {
            ...buildListingPayload().components[0].productSnapshot,
            sku: 'SKU-2',
          },
        },
      ],
    });

    expect(result.components).toHaveLength(2);
    expect(result.components[1]).toEqual(
      expect.objectContaining({
        sku: 'SKU-2',
        count: 3,
        productType: 'ACCESSORY',
      }),
    );
  });

  it('rejects PERSONAL inventory payloads unless kind is LISTING', () => {
    const personalUser = { accountType: 'PERSONAL' } as AuthUserType;

    expect(() =>
      validateCreateInventoryItemInput(
        {
          kind: 'STOCK',
          quantity: 2,
          components: buildListingPayload().components,
          photos: [],
        },
        personalUser,
      ),
    ).toThrow(/LISTING/i);
  });

  it('rejects PERSONAL LISTING payloads when a component omits both imei and fallbackCode', () => {
    const personalUser = { accountType: 'PERSONAL' } as AuthUserType;

    expect(() =>
      validateCreateInventoryItemInput(
        {
          kind: 'LISTING',
          components: [
            {
              sku: 'SKU-1',
              productType: 'PHONE',
              productSnapshot: buildListingPayload().components[0].productSnapshot,
            },
          ],
          photos: [],
        },
        personalUser,
      ),
    ).toThrow(/imei|fallbackCode/i);
  });

  it('accepts PERSONAL LISTING payloads with component-level fallbackCode', () => {
    const personalUser = { accountType: 'PERSONAL' } as AuthUserType;

    const result = validateCreateInventoryItemInput(
      {
        kind: 'LISTING',
        components: [
          {
            sku: 'SKU-1',
            productType: 'PHONE',
            fallbackCode: 'encrypted-fallback-code',
            productSnapshot: buildListingPayload().components[0].productSnapshot,
          },
        ],
        photos: [],
      },
      personalUser,
    );

    expect(result.components[0]).toEqual(
      expect.objectContaining({
        count: 1,
        fallbackCode: 'encrypted-fallback-code',
      }),
    );
  });

  it('normalizes stale mainPhotoHash to null when create payload photos are explicitly empty', () => {
    expect(
      validateCreateInventoryItemInput({
        ...buildListingPayload(),
        mainPhotoHash: 'stale-photo-checksum',
      }),
    ).toEqual(
      expect.objectContaining({
        photos: [],
        mainPhotoHash: null,
      }),
    );
  });

  it('normalizes stale mainPhotoHash to null when write payload photos are explicitly empty', () => {
    expect(
      validateWriteInventoryItemInput({
        ...buildListingPayload(),
        mainPhotoHash: 'stale-photo-checksum',
      }),
    ).toEqual(
      expect.objectContaining({
        photos: [],
        mainPhotoHash: null,
      }),
    );
  });
});

describe('validateUpdateInventoryItemInput', () => {
  it('accepts empty update payloads without forcing photo defaults', () => {
    expect(validateUpdateInventoryItemInput({})).toEqual({});
  });

  it('accepts photo-only update payloads without quantity', () => {
    expect(
      validateUpdateInventoryItemInput({
        photos: [
          {
            checksum: 'checksum-1',
            assetRef: 'inventory/items/seller-1/listing-photo/ph_1',
            key: 'media/image/checksum-1/original.jpeg',
            name: 'photo.jpg',
            mimeType: 'image/jpeg',
            size: 1024,
          },
        ],
        mainPhotoHash: 'checksum-1',
      }),
    ).toEqual({
      photos: [
        {
          checksum: 'checksum-1',
          assetRef: 'inventory/items/seller-1/listing-photo/ph_1',
          key: 'media/image/checksum-1/original.jpeg',
          name: 'photo.jpg',
          mimeType: 'image/jpeg',
          size: 1024,
        },
      ],
      mainPhotoHash: 'checksum-1',
    });
  });

  it('rejects newly uploaded photos that omit assetRef', () => {
    expect(() =>
      validateUpdateInventoryItemInput({
        photos: [
          {
            checksum: 'checksum-1',
            key: 'media/image/checksum-1/original.jpeg',
            name: 'photo.jpg',
            mimeType: 'image/jpeg',
            size: 1024,
          },
        ],
      }),
    ).toThrow(/assetRef/i);
  });

  it('accepts existing photos referenced by blobId without replaying media metadata', () => {
    expect(
      validateUpdateInventoryItemInput({
        photos: [
          {
            blobId: 91,
            checksum: 'checksum-1',
          },
        ],
      }),
    ).toEqual({
      photos: [
        {
          blobId: 91,
          checksum: 'checksum-1',
        },
      ],
    });
  });

  it('normalizes stale mainPhotoHash to null when update payload photos are explicitly empty', () => {
    expect(
      validateUpdateInventoryItemInput({
        photos: [],
        mainPhotoHash: 'stale-photo-checksum',
      }),
    ).toEqual({
      photos: [],
      mainPhotoHash: null,
    });
  });
});
