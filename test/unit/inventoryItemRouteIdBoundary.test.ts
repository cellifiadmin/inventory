import fs from 'fs';
import path from 'path';

describe('inventory item route id boundary', () => {
  it('reads inventory attachments and movements by inventory item id instead of offer id', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/inventory/services/itemListingService.ts'),
      'utf8'
    );

    expect(source).toContain('const getOwnedInventoryItemById = async');
    expect(source).toMatch(
      /getInventoryItemMovements[\s\S]*getOwnedInventoryItemById\(id,\s*user\)/
    );
    expect(source).toMatch(
      /getInventoryItemCdnUrls[\s\S]*getOwnedInventoryItemById\(id,\s*user\)/
    );
    expect(source).not.toMatch(
      /getInventoryItemMovements[\s\S]*getOfferWithItemById\(id,\s*user\)/
    );
    expect(source).not.toMatch(
      /getInventoryItemCdnUrls[\s\S]*getOfferWithItemById\(id,\s*user\)/
    );
  });
});
