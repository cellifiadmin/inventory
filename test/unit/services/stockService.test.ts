import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '@/lib/prismaInventoryTypes';
const mockMovementFindMany = jest.fn<(...args: unknown[]) => Promise<Array<{ quantity: number; direction: 'IN' | 'OUT' }>>>();
const mockMovementCreate = jest.fn<(...args: unknown[]) => Promise<{ id: number }>>();
const mockItemFindUnique = jest.fn<(...args: unknown[]) => Promise<{ id: number } | null>>();
const mockQueryRaw = jest.fn<(...args: unknown[]) => Promise<Array<{ id: number }>>>();
const mockDb = { movement: { findMany: mockMovementFindMany, create: mockMovementCreate },
  item: { findUnique: mockItemFindUnique }, $queryRaw: mockQueryRaw };
const mockTransaction = jest.fn(async (work: (tx: typeof mockDb) => Promise<unknown>) => work(mockDb));
jest.mock('@/lib/prismaInventory', () => ({ __esModule: true, default: {
  ...mockDb, $transaction: (...args: Parameters<typeof mockTransaction>) => mockTransaction(...args),
} }));
import { calculateRemainingQuantity, calculateRemainingQuantityForBoundary, createStockMovement,
  findInventoryItemIdByBoundary, getStockMovements } from '@/services/stockService';

beforeEach(() => {
  jest.clearAllMocks();
  mockMovementFindMany.mockResolvedValue([{ quantity: 5, direction: 'IN' }, { quantity: 2, direction: 'OUT' }]);
  mockMovementCreate.mockResolvedValue({ id: 4 }); mockItemFindUnique.mockResolvedValue({ id: 10 }); mockQueryRaw.mockResolvedValue([{ id: 10 }]);
});
describe('stock ledger reads and serialized writes', () => {
  it('derives quantity only from signed ledger movements', async () => { expect(await calculateRemainingQuantity(10)).toBe(3); });
  it.each([[null, 'code'], ['seller', null]])('returns no item for incomplete boundary %p', async (seller, code) => {
    expect(await findInventoryItemIdByBoundary(seller, code)).toBeNull();
    expect(mockItemFindUnique).not.toHaveBeenCalled();
  });
  it('returns no item for an unknown boundary', async () => {
    mockItemFindUnique.mockResolvedValue(null); expect(await findInventoryItemIdByBoundary('seller', 'code')).toBeNull();
    expect(await calculateRemainingQuantityForBoundary('seller', 'code')).toBe(0);
  });
  it('reads the boundary-owned item balance', async () => { expect(await calculateRemainingQuantityForBoundary('seller', 'code')).toBe(3); });
  it.each([0, -1, 1.5])('rejects invalid movement quantity %p', async quantity => {
    await expect(createStockMovement({ itemId: 10, quantity, direction: 'OUT', reason: 'SOLD' })).rejects.toThrow('Invalid quantity');
    expect(mockTransaction).not.toHaveBeenCalled();
  });
  it('locks the item before checking an outbound movement and returns the committed movement', async () => {
    expect(await createStockMovement({ itemId: 10, quantity: 3, direction: 'OUT', reason: 'SOLD' })).toEqual({ id: 4 });
    expect(mockQueryRaw.mock.invocationCallOrder[0]).toBeLessThan(mockMovementFindMany.mock.invocationCallOrder[0]);
    expect(mockMovementCreate).toHaveBeenCalledWith({ data: { itemId: 10, quantity: 3, direction: 'OUT', reason: 'SOLD', metadata: Prisma.JsonNull, createdBy: null } });
  });
  it('rejects an outbound movement larger than the locked ledger balance', async () => {
    await expect(createStockMovement({ itemId: 10, quantity: 4, direction: 'OUT', reason: 'SOLD' })).rejects.toThrow('Insufficient inventory available');
    expect(mockMovementCreate).not.toHaveBeenCalled();
  });
  it('serializes inbound stock and preserves supplied attribution', async () => {
    await createStockMovement({ itemId: 10, quantity: 2, direction: 'IN', reason: 'STOCKED', metadata: { received: 'batch' }, createdBy: 8 });
    expect(mockQueryRaw).toHaveBeenCalledTimes(1); expect(mockMovementFindMany).not.toHaveBeenCalled();
    expect(mockMovementCreate).toHaveBeenCalledWith({ data: { itemId: 10, quantity: 2, direction: 'IN', reason: 'STOCKED', metadata: { received: 'batch' }, createdBy: 8 } });
  });
  it('reads movement history in descending creation order', async () => {
    await getStockMovements(10);
    expect(mockMovementFindMany).toHaveBeenCalledWith({ where: { itemId: 10 }, orderBy: { createdAt: 'desc' } });
  });
});
