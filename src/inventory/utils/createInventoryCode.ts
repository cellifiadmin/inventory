type InventoryCompositionItem = {
  sku: string;
  count: number;
  productType: string;
  identifier?: string | null;
};

const normalizeCount = (count: number) => {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`Inventory composition count must be a positive integer. Received: ${count}`);
  }

  return String(count);
};

export const createInventoryCode = (items: InventoryCompositionItem[]) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Inventory composition must include at least one component.');
  }

  return [...items]
    .map((item) => {
      const sku = item.sku?.trim();

      if (!sku) {
        throw new Error('Inventory composition sub-item is missing a SKU.');
      }

      const productType = item.productType?.trim();

      if (!productType) {
        throw new Error('Inventory composition sub-item is missing a productType.');
      }

      const identifier = item.identifier?.trim() || null;
      const normalizedType = identifier ? 'I' : 'B';
      const encodedCode = identifier
        ? `I:${productType}:${sku}:${identifier}`
        : `B:${productType}:${sku}:${normalizeCount(item.count)}`;

      return {
        type: normalizedType,
        sku,
        identifier,
        count: item.count,
        encodedCode,
      };
    })
    .sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === 'B' ? -1 : 1;
      }

      if (left.type === 'B') {
        const skuComparison = left.sku.localeCompare(right.sku);

        if (skuComparison !== 0) {
          return skuComparison;
        }

        const countComparison = left.count - right.count;

        if (countComparison !== 0) {
          return countComparison;
        }

        return left.encodedCode.localeCompare(right.encodedCode);
      }

      const identifierComparison = (left.identifier || '').localeCompare(right.identifier || '');

      if (identifierComparison !== 0) {
        return identifierComparison;
      }

      return left.encodedCode.localeCompare(right.encodedCode);
    })
    .map(({ encodedCode }) => encodedCode)
    .join('::');
};
