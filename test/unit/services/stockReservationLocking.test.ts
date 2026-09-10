import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const asyncMock = (value: unknown) => jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(value);
const now = new Date('2030-01-01T00:00:00Z');
const makeTx = () => ({
  item: { findUnique: asyncMock({ id: 10, deletedAt: null }) },
  movement: { findMany: asyncMock([]), create: asyncMock({ id: 1 }) },
  $queryRaw: asyncMock(null).mockImplementation(async (parts, ...values) =>
    parts.join('').includes('clock_timestamp') ? [{ now }]
      : parts.join('').includes('FROM items') ? [{ id: values[0] }] : []),
});
let mockTx: ReturnType<typeof makeTx>;
jest.mock('@/lib/prismaInventory', () => ({ __esModule: true, default: {
  $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(mockTx),
} }));
import { reserveStock } from '@/inventory/services/stockReservationService';
const line = { lineId: 'line', accountId: 'seller', sourceInvId: 'item', quantity: 1 };
const input = { checkoutId: 'checkout', version: 1, lines: [line] };
const hold = { id: 20, itemId: 10, quantity: 1, reason: 'RESERVED', direction: 'OUT',
  metadata: { checkoutId: 'checkout', version: 1, lineId: 'line', expiresAt: '2030-01-01T00:02:00.000Z' } };
const stock = { id: 1, itemId: 10, quantity: 5, reason: 'ADJUSTMENT', direction: 'IN' };

describe('stock reservation locks and aggregate validation', () => {
  beforeEach(() => { mockTx = makeTx(); process.env.STOCK_RESERVATION_TIMEOUT_MINUTES = '15';
    mockTx.movement.findMany.mockImplementation(async ({ where }) => where.itemId ? [stock] : []); });
  it('locks distinct item rows in ascending order before reading stock and uses database time', async () => {
    mockTx.item.findUnique.mockResolvedValueOnce({ id: 20, deletedAt: null }).mockResolvedValueOnce({ id: 10, deletedAt: null });
    const result = await reserveStock({ ...input, lines: [{ ...line, sourceInvId: 'other' }, { ...line, lineId: 'second' }] });
    const locks = mockTx.$queryRaw.mock.calls.filter(([parts]) => parts.join('').includes('FROM items'));
    expect(locks.map(([, id]) => id)).toEqual([10, 20]);
    expect(result.expiresAt).toBe('2030-01-01T00:15:00.000Z');
    expect(mockTx.movement.create).toHaveBeenCalledTimes(2);
  });
  it('locks a shared item once and checks total requested units before creating movements', async () => {
    await expect(reserveStock({ ...input, lines: [{ ...line, quantity: 3 }, { ...line, lineId: 'second', quantity: 3 }] }))
      .rejects.toThrow('Insufficient inventory available for item');
    expect(mockTx.$queryRaw.mock.calls.filter(([parts]) => parts.join('').includes('FROM items'))).toHaveLength(1);
    expect(mockTx.movement.create).not.toHaveBeenCalled();
  });
  it.each([null, { id: 10, deletedAt: now }])('rejects missing or deleted item %p', async item => {
    mockTx.item.findUnique.mockResolvedValue(item);
    await expect(reserveStock(input)).rejects.toThrow('Inventory item not found for item');
  });
  it('rejects an item deleted between lookup and lock acquisition', async () => {
    mockTx.$queryRaw.mockResolvedValue([]);
    await expect(reserveStock(input)).rejects.toThrow('Inventory item not found for item');
    expect(mockTx.movement.create).not.toHaveBeenCalled();
  });
  it.each([{ ...hold, itemId: 99 }, { ...hold, quantity: 2 }])('rejects changed existing hold identity %p', async existing => {
    mockTx.movement.findMany.mockImplementation(async ({ where }) => where.itemId ? [stock] : where.reason === 'RESERVED' ? [existing] : []);
    await expect(reserveStock(input)).rejects.toThrow('Reservation input changed for line');
  });
  it('reuses a matching hold and rejects absent expiry without another movement', async () => {
    mockTx.movement.findMany.mockImplementation(async ({ where }) => where.itemId ? [stock] : where.reason === 'RESERVED' ? [hold] : []);
    expect((await reserveStock(input)).expiresAt).toBe(hold.metadata.expiresAt);
    mockTx.movement.findMany.mockImplementation(async ({ where }) => where.itemId ? [stock] : where.reason === 'RESERVED' ? [{ ...hold, metadata: {} }] : undefined);
    await expect(reserveStock(input)).rejects.toThrow('Reservation expiry invalid or elapsed for line');
    expect(mockTx.movement.create).not.toHaveBeenCalled();
  });
  it('tolerates no scoped movements while retaining a real item ledger result', async () => {
    mockTx.movement.findMany.mockImplementation(async ({ where }) => where.itemId ? [stock] : undefined);
    await reserveStock(input); expect(mockTx.movement.create).toHaveBeenCalledTimes(1);
  });
  it('returns the earliest existing reservation deadline across lines', async () => {
    mockTx.movement.findMany.mockImplementation(async ({ where }) => {
      if (where.itemId) return [stock];
      if (where.reason !== 'RESERVED') return [];
      const lineId = where.AND[2].metadata.equals;
      return [{ ...hold, metadata: { ...hold.metadata, lineId,
        expiresAt: lineId === 'second' ? '2030-01-01T00:01:00.000Z' : '2030-01-01T00:02:00.000Z' } }];
    });
    expect((await reserveStock({ ...input, lines: [line, { ...line, lineId: 'second' }, { ...line, lineId: 'third' }] })).expiresAt)
      .toBe('2030-01-01T00:01:00.000Z');
  });
  it('rejects a hold whose expiry elapsed without extending it', async () => {
    mockTx.movement.findMany.mockImplementation(async ({ where }) => where.itemId ? [stock] : where.reason === 'RESERVED'
      ? [{ ...hold, metadata: { ...hold.metadata, expiresAt: now.toISOString() } }] : []);
    await expect(reserveStock(input)).rejects.toThrow('Reservation expiry invalid or elapsed for line');
    expect(mockTx.movement.create).not.toHaveBeenCalled();
  });

  it.each([
    ['2030-01-01T00:20:00.000Z', '2030-01-01T00:15:00.000Z'],
    ['2030-01-01T00:02:00.000Z', '2030-01-01T00:02:00.000Z'],
  ])('bounds a mixed new/replayed batch by its earliest actual deadline %s', async (existingExpiry, expected) => {
    mockTx.movement.findMany.mockImplementation(async ({ where }) => {
      if (where.itemId) return [stock];
      return where.reason === 'RESERVED' && where.AND[2].metadata.equals === 'line'
        ? [{ ...hold, metadata: { ...hold.metadata, expiresAt: existingExpiry } }] : [];
    });
    expect((await reserveStock({ ...input, lines: [line, { ...line, lineId: 'new-line' }] })).expiresAt).toBe(expected);
  });

});
