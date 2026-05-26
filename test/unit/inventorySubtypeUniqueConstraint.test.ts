import fs from 'fs';
import path from 'path';

const getModelBlock = (schema: string, modelName: string): string => {
  const match = schema.match(new RegExp(`model ${modelName} \\{[\\s\\S]*?\\n\\}`));

  expect(match).not.toBeNull();

  return match?.[0] ?? '';
};

describe('inventory subtype unique constraints', () => {
  it('keys instance and bundle uniqueness by product type in the standalone inventory schema', () => {
    const inventorySchema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    const inventoryInstance = getModelBlock(inventorySchema, 'Instance');
    const inventoryBundle = getModelBlock(inventorySchema, 'Bundle');

    expect(inventoryInstance).toContain('productType');
    expect(inventoryInstance).toContain(
      '@@unique([identifier, sku, productType])'
    );
    expect(inventoryBundle).toContain('productType');
    expect(inventoryBundle).toContain(
      '@@unique([sku, productType, count])'
    );
  });
});
