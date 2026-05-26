import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@/inventory/services/itemListingService', () => ({
  getInventoryItemCdnUrls: jest.fn(),
  getInventoryItemsBatchCdnUrls: jest.fn(),
}));

const mockGetInventoryItemCdnUrls = jest.mocked(
  jest.requireMock('@/inventory/services/itemListingService')
    .getInventoryItemCdnUrls,
);
const mockGetInventoryItemsBatchCdnUrls = jest.mocked(
  jest.requireMock('@/inventory/services/itemListingService')
    .getInventoryItemsBatchCdnUrls,
);

import { handler as attachmentsCdnHandler } from '@/inventory/handlers/items/attachmentsCdn';
import { handler as batchAttachmentsCdnHandler } from '@/inventory/handlers/items/batchAttachmentsCdn';

const authEvent = {
  requestContext: {
    authorizer: {
      lambda: {
        authUser: JSON.stringify({
          userIdentifier: 'user-1',
          userName: 'Abdul',
          userRoles: [],
          accountIdentifier: 'acct-1',
          accountName: 'Account 1',
          accountType: 'BUSINESS',
          local: true,
          online: true,
          isAdmin: true,
        }),
      },
    },
  },
};

describe('inventory attachments CDN cache control', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('disables caching for the single-item attachments CDN response', async () => {
    mockGetInventoryItemCdnUrls.mockResolvedValue({
      mainImage: null,
      images: [],
    });

    const response = await attachmentsCdnHandler(
      {
        ...authEvent,
        pathParameters: { id: '3' },
      } as any,
      {} as any,
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers?.['Cache-Control']).toBe('no-store');
  });

  it('disables caching for the batch attachments CDN response', async () => {
    mockGetInventoryItemsBatchCdnUrls.mockResolvedValue({
      '3': [],
    });

    const response = await batchAttachmentsCdnHandler(
      {
        ...authEvent,
        queryStringParameters: { listingIds: '3' },
      } as any,
      {} as any,
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers?.['Cache-Control']).toBe('no-store');
  });
});
