import {
  Prisma,
  ComponentChildType,
  ItemKind,
  MovementDirection,
  MovementReason,
  ProductType,
} from '@/lib/prismaInventoryTypes';

it('exposes the generated Inventory transaction API and domain enums through the canonical module', () => {
  expect(Prisma.TransactionIsolationLevel.Serializable).toBe('Serializable');
  for (const domain of [
    ComponentChildType,
    ItemKind,
    MovementDirection,
    MovementReason,
    ProductType,
  ]) {
    expect(Object.keys(domain).length).toBeGreaterThan(0);
    expect(Object.values(domain).every((value) => typeof value === 'string')).toBe(true);
  }
  expect(ItemKind.STOCK).toBe('STOCK');
  expect(MovementDirection.IN).toBe('IN');
  expect(MovementDirection.OUT).toBe('OUT');
  expect(MovementReason.ADJUSTMENT).toBe('ADJUSTMENT');
});
