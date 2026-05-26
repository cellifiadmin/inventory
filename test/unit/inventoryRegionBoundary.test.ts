import fs from 'fs';
import path from 'path';

describe('inventory item region boundary', () => {
  it('removes regionId from the standalone inventory schema and runtime paths', () => {
    const inventorySchema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    const inventoryItemService = fs.readFileSync(
      path.join(process.cwd(), 'src/inventory/services/inventoryItemService.ts'),
      'utf8'
    );
    const userService = fs.readFileSync(
      path.join(process.cwd(), 'src/services/userService.ts'),
      'utf8'
    );
    const itemListingService = fs.readFileSync(
      path.join(process.cwd(), 'src/inventory/services/itemListingService.ts'),
      'utf8'
    );

    expect(inventorySchema).not.toContain('regionId');
    expect(inventorySchema).not.toContain('region_id');
    expect(inventoryItemService).not.toContain('getUserRegion(');
    expect(inventoryItemService).not.toContain('regionId:');
    expect(userService).not.toContain('export const getUserRegion');
    expect(userService).not.toContain('export const getRegionFromAddress');
    expect(itemListingService).not.toContain("'regionId', inventory_items.region_id");
  });
});
