import prismaInventory from '@/lib/prismaInventory';
import { buildObjectPublicUrl } from '@/lib/objectStorage';

// SQS FIFO limit is 256 KB - cap images to prevent payload bloat
const MAX_IMAGES_PER_PRODUCT = 10;

export interface MarketplaceImage {
  url: string;
  name: string;
  isMain: boolean;  // Use camelCase for API contracts (JavaScript convention)
}

/**
 * Generate CloudFront URLs for inventory item images
 * NO S3 copying - just URL transformation!
 *
 * CloudFront OAC serves images directly from private S3 bucket
 * URL pattern: https://{cloudfront-domain}/{blob.key}
 *
 * IMPORTANT: Always uses global prisma client (not transaction client)
 * to ensure it reads committed data from the database.
 *
 * @param invItemId - Inventory item ID
 * @param mainImageId - ID of the attachment that is the main image (or null if no main image)
 *
 * @example
 * const images = await getMarketplaceCDNUrls(
 *   offer.inventoryItem.id,
 *   offer.inventoryItem.mainImageId
 * );
 */
export async function getMarketplaceCDNUrls(
  invItemId: number,
  mainImageId: number | null
): Promise<MarketplaceImage[]> {
  // Fetch attachments with blobs (limited to prevent SQS payload bloat)
  // ALWAYS use global prisma client - reads committed data
  const attachments = await prismaInventory.attachment.findMany({
    where: {
      attachableId: invItemId,
      attachableType: 'InventoryItem',
    },
    include: { blob: true },
    orderBy: [
      { createdAt: 'asc' }  // Order by creation time (oldest first)
    ],
    take: MAX_IMAGES_PER_PRODUCT  // Guard against payload bloat
  });

  if (attachments.length === 0) {
    return [];
  }

  // Transform S3 keys to CloudFront URLs (pure function, no I/O!)
  return attachments.map((attachment: any) => {
    const { blob } = attachment;

    // CloudFront URL = CDN domain + existing S3 key
    // Example: https://d123.cloudfront.net/products/seller-789/image/abc123.jpg
    const cdnUrl = buildObjectPublicUrl(blob.key);

    return {
      url: cdnUrl,
      name: blob.name,
      isMain: attachment.id === mainImageId  // Check actual mainImageId (not array index)
    };
  });
}

/**
 * Helper: Generate single CDN URL from blob key
 * Useful for API responses, preview URLs, etc.
 */
export function blobKeyToCDNUrl(blobKey: string): string {
  return buildObjectPublicUrl(blobKey);
}
