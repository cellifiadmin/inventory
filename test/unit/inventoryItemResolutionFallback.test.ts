import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import prismaInventory from '@/lib/prismaInventory';
import { resolveInventoryItemBoundary } from '@/inventory/services/inventoryItemService';
import { createInventoryCode } from '@/inventory/utils/createInventoryCode';
import * as stockService from '@/services/stockService';
import {
  buildSerializedComponent,
  TEST_SERIALIZED_PRODUCT_TYPE,
} from '../helpers/factories';

const sellerIdentifier = 'seller-1';
const identifier = '354210975944783';

const buildListingComponentInput = ({
  imei = identifier,
}: {
  imei?: string;
} = {}) => {
  const component = buildSerializedComponent({
    sellerIdentifier,
    identifier: imei,
    productType: TEST_SERIALIZED_PRODUCT_TYPE,
    product: {
      sku: 'SKU1',
      batteryLevel: 91,
      brand: { key: 'APPLE', name: 'Apple' },
      model: { key: 'IP16', name: 'iPhone 16' },
      color: { key: 'WHITE', name: 'White', hexValue: '#FFFFFF' },
      storage: { key: '128GB', name: '128 GB' },
      condition: { key: 'GOOD', label: 'Good' },
      carrier: null,
    },
  });

  return {
    sku: component.sku,
    count: 1,
    productType: TEST_SERIALIZED_PRODUCT_TYPE,
    imei,
    productSnapshot: {
      sellerIdentifier: component.sellerIdentifier,
      sku: component.sku,
      batteryLevel: component.batteryLevel,
      brand: component.brand,
      model: component.model,
      color: component.color,
      storage: component.storage,
      condition: component.condition,
      carrier: component.carrier,
    },
  };
};

const requestedComponents = [buildListingComponentInput()];

const createBundleComponent = ({
  productType = TEST_SERIALIZED_PRODUCT_TYPE,
  fallbackCode,
  count = 1,
}: {
  productType?: string;
  fallbackCode?: string;
  count?: number;
} = {}) => {
  const component = buildSerializedComponent({
    sellerIdentifier,
    productType,
    product: {
      sku: 'SKU1',
      batteryLevel: 91,
      brand: { key: 'APPLE', name: 'Apple' },
      model: { key: 'IP16', name: 'iPhone 16' },
      color: { key: 'WHITE', name: 'White', hexValue: '#FFFFFF' },
      storage: { key: '128GB', name: '128 GB' },
      condition: { key: 'GOOD', label: 'Good' },
      carrier: null,
    },
  });

  return {
    sku: component.sku,
    count,
    productType,
    ...(fallbackCode ? { fallbackCode } : {}),
    productSnapshot: {
      sellerIdentifier: component.sellerIdentifier,
      sku: component.sku,
      batteryLevel: component.batteryLevel,
      brand: component.brand,
      model: component.model,
      color: component.color,
      storage: component.storage,
      condition: component.condition,
      carrier: component.carrier,
    },
  };
};

describe('resolveInventoryItemBoundary', () => {
  beforeEach(() => {
    jest
      .spyOn(stockService, 'calculateRemainingQuantity')
      .mockResolvedValue(1 as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('resolves a component imei without relying on top-level identifier', async () => {
    const expectedCode = createInventoryCode([
      {
        sku: 'SKU1',
        count: 1,
        productType: TEST_SERIALIZED_PRODUCT_TYPE,
        identifier,
      },
    ]);
    const componentFindFirstSpy = jest
      .spyOn(prismaInventory.component, 'findFirst')
      .mockResolvedValue({
        id: 700,
        itemId: 44,
      } as never);
    const itemFindUniqueSpy = jest
      .spyOn(prismaInventory.item, 'findUnique')
      .mockResolvedValue({
        id: 44,
        kind: 'LISTING',
        itemCode: expectedCode,
        sellerIdentifier,
        deletedAt: null,
        mainImage: {
          blob: {
            id: 90,
            checksum: 'main-photo',
            key: 'inventory/main-photo.jpg',
            name: 'main-photo.jpg',
            size: 1024,
            fileType: 'image',
            extension: 'jpeg',
          },
        },
        images: [
          {
            blob: {
              id: 90,
              checksum: 'main-photo',
              key: 'inventory/main-photo.jpg',
              name: 'main-photo.jpg',
              size: 1024,
              fileType: 'image',
              extension: 'jpeg',
            },
          },
        ],
        components: [
          {
            id: 700,
            childType: 'INSTANCE',
            position: 0,
            componentSnapshot: {
              sku: 'SKU1',
              count: 1,
              productType: TEST_SERIALIZED_PRODUCT_TYPE,
              imei: identifier,
              productSnapshot: requestedComponents[0].productSnapshot,
            },
            instance: {
              id: 51,
              identifier,
              sku: 'SKU1',
              productType: TEST_SERIALIZED_PRODUCT_TYPE,
            },
            bundle: null,
          },
        ],
      } as never);
    const itemFindFirstSpy = jest
      .spyOn(prismaInventory.item, 'findFirst')
      .mockResolvedValue({
        id: 44,
        kind: 'LISTING',
        itemCode: expectedCode,
        sellerIdentifier,
        deletedAt: null,
        mainImage: {
          blob: {
            id: 90,
            checksum: 'main-photo',
            key: 'inventory/main-photo.jpg',
            name: 'main-photo.jpg',
            size: 1024,
            fileType: 'image',
            extension: 'jpeg',
          },
        },
        images: [
          {
            blob: {
              id: 90,
              checksum: 'main-photo',
              key: 'inventory/main-photo.jpg',
              name: 'main-photo.jpg',
              size: 1024,
              fileType: 'image',
              extension: 'jpeg',
            },
          },
        ],
        components: [
          {
            id: 700,
            childType: 'INSTANCE',
            position: 0,
            componentSnapshot: {
              sku: 'SKU1',
              count: 1,
              productType: TEST_SERIALIZED_PRODUCT_TYPE,
              imei: identifier,
              productSnapshot: requestedComponents[0].productSnapshot,
            },
            instance: {
              id: 51,
              identifier,
              sku: 'SKU1',
              productType: TEST_SERIALIZED_PRODUCT_TYPE,
            },
            bundle: null,
          },
        ],
      } as never);

    const result = await resolveInventoryItemBoundary(
      {
        accountIdentifier: sellerIdentifier,
      } as any,
      {
        kind: 'LISTING',
        components: requestedComponents,
      } as any
    );

    expect(componentFindFirstSpy).toHaveBeenCalled();
    expect(itemFindUniqueSpy).toHaveBeenCalled();
    expect(itemFindFirstSpy).toHaveBeenCalled();
    const identifierLookup = JSON.stringify(componentFindFirstSpy.mock.calls[0]?.[0] ?? {});
    const codeLookup = JSON.stringify(itemFindFirstSpy.mock.calls[0]?.[0] ?? {});
    expect(identifierLookup).toContain(identifier);
    expect(codeLookup).toContain(expectedCode);
    expect(result.resolvedInventoryItem).toEqual(
      expect.objectContaining({
        id: 44,
        code: expectedCode,
        sellerIdentifier,
        quantity: 1,
        mainPhoto: expect.objectContaining({
          checksum: 'main-photo',
        }),
      })
    );
    expect(result.resolvedInventoryItem?.invSnapshot.components).toEqual([
      expect.objectContaining({
        sku: 'SKU1',
        count: 1,
      }),
    ]);
  });

  it('uses component fallbackCode without relying on top-level fallback data when resolving a bundle', async () => {
    const findFirstSpy = jest
      .spyOn(prismaInventory.item, 'findFirst')
      .mockResolvedValue(null as never);

    await resolveInventoryItemBoundary(
      {
        accountIdentifier: sellerIdentifier,
      } as any,
      {
        kind: 'STOCK',
        components: [createBundleComponent({ fallbackCode: 'fallback-code-1' })],
      } as any,
    );

    expect(findFirstSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          sellerIdentifier,
          itemCode: expect.any(String),
        },
      }),
    );
  });

  it('allows mixed product types inside one STOCK composition', async () => {
    const findFirstSpy = jest
      .spyOn(prismaInventory.item, 'findFirst')
      .mockResolvedValue(null as never);

    await expect(
      resolveInventoryItemBoundary(
        {
          accountIdentifier: sellerIdentifier,
        } as any,
        {
          kind: 'STOCK',
          components: [
            createBundleComponent({ productType: 'PHONE' }),
            createBundleComponent({ productType: 'WATCH' }),
          ],
        } as any,
      ),
    ).resolves.toEqual({ resolvedInventoryItem: null });

    expect(findFirstSpy).toHaveBeenCalledTimes(1);
  });

  it('raises an IMEI_CONFLICT with a same-seller listing link when the conflicting identifier already belongs to a seller listing', async () => {
    const conflictingItemCode = createInventoryCode([
      {
        sku: 'SKU1',
        count: 1,
        productType: TEST_SERIALIZED_PRODUCT_TYPE,
        identifier: '000000000000001',
      },
    ]);

    jest
      .spyOn(prismaInventory.component, 'findFirst')
      .mockResolvedValueOnce({
        id: 701,
        itemId: 77,
      } as never);

    jest
      .spyOn(prismaInventory.item, 'findUnique')
      .mockResolvedValueOnce({
        id: 77,
        kind: 'LISTING',
        itemCode: conflictingItemCode,
        sellerIdentifier,
        deletedAt: null,
        mainImage: null,
        images: [],
        components: [],
      } as never);

    jest.spyOn(prismaInventory.offersOffer, 'findFirst').mockResolvedValueOnce({
      id: 901,
    } as never);

    await expect(
      resolveInventoryItemBoundary(
        {
          accountIdentifier: sellerIdentifier,
        } as any,
        {
          kind: 'LISTING',
          components: requestedComponents,
        } as any,
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      name: 'IMEI_CONFLICT',
      message:
        'The provided IMEI is already used for a previous listing. You can view it here.',
      details: {
        title: 'IMEI Already Used',
        messageBeforeLink:
          'The provided IMEI is already used for a previous listing. You can view it ',
        messageAfterLink: '.',
        link: {
          label: 'here',
          href: '/manage/listings/901',
        },
      },
    });
  });

  it('raises an IMEI_CONFLICT without a link when the conflicting identifier belongs to a different seller', async () => {
    const conflictingItemCode = createInventoryCode([
      {
        sku: 'SKU1',
        count: 1,
        productType: TEST_SERIALIZED_PRODUCT_TYPE,
        identifier: '000000000000001',
      },
    ]);

    jest
      .spyOn(prismaInventory.component, 'findFirst')
      .mockResolvedValueOnce({
        id: 702,
        itemId: 88,
      } as never);

    jest
      .spyOn(prismaInventory.item, 'findUnique')
      .mockResolvedValueOnce({
        id: 88,
        kind: 'LISTING',
        itemCode: conflictingItemCode,
        sellerIdentifier: 'other-seller',
        deletedAt: null,
        mainImage: null,
        images: [],
        components: [],
      } as never);

    await expect(
      resolveInventoryItemBoundary(
        {
          accountIdentifier: sellerIdentifier,
        } as any,
        {
          kind: 'LISTING',
          components: requestedComponents,
        } as any,
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      name: 'IMEI_CONFLICT',
      message:
        'The provided IMEI is already used in a different listing. If you believe this is an error, please report it to support@cellifi.com and include the IMEI in the email body.',
      details: {
        title: 'IMEI Already Used',
      },
    });
  });
});
