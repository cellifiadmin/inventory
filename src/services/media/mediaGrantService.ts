import { randomUUID } from 'node:crypto';

export const INVENTORY_MEDIA_DOMAIN = 'inventory' as const;
export const INVENTORY_MEDIA_ITEMS_RESOURCE = 'items' as const;
export const INVENTORY_MEDIA_LISTING_PHOTO_USAGE = 'listing-photo' as const;

type MediaGrantUser = {
  accountIdentifier: string;
};

export const createInventoryListingPhotoMediaGrant = (
  user: MediaGrantUser,
) => ({
  domain: INVENTORY_MEDIA_DOMAIN,
  resource: INVENTORY_MEDIA_ITEMS_RESOURCE,
  resourceKey: user.accountIdentifier,
  usage: INVENTORY_MEDIA_LISTING_PHOTO_USAGE,
  assetKey: `ph_${randomUUID().replace(/-/g, '')}`,
});
