import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  INVENTORY_MEDIA_DOMAIN,
  INVENTORY_MEDIA_ITEMS_RESOURCE,
  INVENTORY_MEDIA_LISTING_PHOTO_USAGE,
  createInventoryListingPhotoMediaGrant,
} from '@/services/media/mediaGrantService';

describe('mediaGrantService', () => {
  it('registers the inventory media-grants route', () => {
    const serverlessSource = readFileSync(
      path.resolve(process.cwd(), 'serverless.yml'),
      'utf8',
    );

    expect(serverlessSource).toContain('path: /inventory/media-grants');
    expect(serverlessSource).toContain('method: post');
  });

  it('builds an item media grant owned by the current inventory account', () => {
    expect(
      createInventoryListingPhotoMediaGrant({
        accountIdentifier: 'acct-d5269b95a974084e90fb',
      }),
    ).toEqual(
      expect.objectContaining({
        domain: INVENTORY_MEDIA_DOMAIN,
        resource: INVENTORY_MEDIA_ITEMS_RESOURCE,
        resourceKey: 'acct-d5269b95a974084e90fb',
        usage: INVENTORY_MEDIA_LISTING_PHOTO_USAGE,
        assetKey: expect.stringMatching(/^ph_[a-zA-Z0-9_-]+$/),
      }),
    );
  });
});
