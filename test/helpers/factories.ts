export const TEST_SERIALIZED_PRODUCT_TYPE = 'PHONE';

export const buildSerializedComponent = ({
  sellerIdentifier,
  identifier = '354210975944783',
  productType = TEST_SERIALIZED_PRODUCT_TYPE,
  product,
}: {
  sellerIdentifier: string;
  identifier?: string;
  productType?: string;
  product: {
    sku: string;
    batteryLevel: number | null;
    brand: { key: string; name: string };
    model: { key: string; name: string };
    color: { key: string; name: string; hexValue: string | null };
    storage: { key: string; name: string };
    condition: { key: string; label: string };
    carrier: { key: string; name: string } | null;
  };
}) => ({
  kind: 'LISTING',
  productType,
  identifier,
  sellerIdentifier,
  sku: product.sku,
  batteryLevel: product.batteryLevel ?? null,
  brand: product.brand,
  model: product.model,
  color: {
    ...product.color,
    hexValue: product.color.hexValue ?? null,
  },
  storage: product.storage,
  condition: product.condition,
  carrier: product.carrier ?? null,
});
