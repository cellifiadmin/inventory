import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockItemFindUnique = jest.fn();
const mockMovementFindMany = jest.fn();
const mockMovementCreate = jest.fn();
const mockTransaction = jest.fn();
const mockQueryRaw = jest.fn<(parts: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>>();

jest.mock('@/lib/prismaInventory', () => ({
  __esModule: true,
  default: {
    item: {
      findUnique: (...args: unknown[]) => mockItemFindUnique(...args),
    },
    movement: {
      findMany: (...args: unknown[]) => mockMovementFindMany(...args),
      create: (...args: unknown[]) => mockMovementCreate(...args),
    },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

describe('stock reservation services', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.STOCK_RESERVATION_TIMEOUT_MINUTES = '15';
    mockQueryRaw.mockImplementation(async (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.join('').includes('clock_timestamp') ? [{ now: new Date('2026-08-03T18:30:00.000Z') }]
        : parts.join('').includes('FROM items') ? [{ id: values[0] }] : []);

    mockTransaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) =>
      callback({
        $queryRaw: mockQueryRaw,
        item: {
          findUnique: mockItemFindUnique,
        },
        movement: {
          findMany: mockMovementFindMany,
          create: mockMovementCreate,
        },
      }),
    );
  });

  it('returns the existing active reservation without duplicating a movement', async () => {
    const reservedMovement = {
      id: 91,
      itemId: 77,
      quantity: 2,
      direction: 'OUT',
      reason: 'RESERVED',
      metadata: {
        checkoutId: 'chk_123',
        version: 1,
        lineId: 'ln_1',
        expiresAt: '2026-08-03T18:45:00.000Z',
      },
    };

    mockItemFindUnique.mockResolvedValue({
      id: 77,
      deletedAt: null,
    });
    mockMovementFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([reservedMovement])
      .mockResolvedValueOnce([]);

    const { reserveStock } = require('@/inventory/services/stockReservationService') as {
      reserveStock: (input: {
        checkoutId: string;
        version: number;
        lines: Array<{
          lineId: string;
          accountId: string;
          sourceInvId: string;
          quantity: number;
        }>;
      }) => Promise<unknown>;
    };

    await expect(
      reserveStock({
        checkoutId: 'chk_123',
        version: 1,
        lines: [
          {
            lineId: 'ln_1',
            accountId: 'acct_seller_1',
            sourceInvId: 'INV-1',
            quantity: 2,
          },
        ],
      }),
    ).resolves.toEqual({
      expiresAt: '2026-08-03T18:45:00.000Z',
      lines: [{ lineId: 'ln_1', quantity: 2 }],
    });

    expect(mockMovementCreate).not.toHaveBeenCalled();
  });

  it('commits a reserved line by writing RELEASED and SOLD movements together', async () => {
    const reservedMovement = {
      id: 91,
      itemId: 77,
      quantity: 2,
      direction: 'OUT',
      reason: 'RESERVED',
      metadata: {
        checkoutId: 'chk_123',
        version: 1,
        lineId: 'ln_1',
        expiresAt: '2026-08-03T18:45:00.000Z',
      },
    };

    mockMovementFindMany
      .mockResolvedValueOnce([reservedMovement])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockMovementCreate.mockResolvedValue({ id: 201 });

    const { commitStock } = require('@/inventory/services/stockCommitService') as {
      commitStock: (input: {
        checkoutId: string;
        version: number;
        lines: Array<{ lineId: string }>;
      }) => Promise<unknown>;
    };

    await expect(
      commitStock({
        checkoutId: 'chk_123',
        version: 1,
        lines: [{ lineId: 'ln_1' }],
      }),
    ).resolves.toEqual({
      lines: [{ lineId: 'ln_1', reservedMovementId: 91 }],
    });

    expect(mockMovementCreate).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        itemId: 77,
        quantity: 2,
        direction: 'IN',
        reason: 'RELEASED',
        metadata: expect.objectContaining({
          checkoutId: 'chk_123',
          version: 1,
          lineId: 'ln_1',
          reservedMovementId: 91,
          cause: 'commit',
        }),
      }),
    });
    expect(mockMovementCreate).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        itemId: 77,
        quantity: 2,
        direction: 'OUT',
        reason: 'SOLD',
        metadata: expect.objectContaining({
          checkoutId: 'chk_123',
          version: 1,
          lineId: 'ln_1',
          reservedMovementId: 91,
        }),
      }),
    });
  });

  it('releases a reserved line idempotently for failed payment', async () => {
    const reservedMovement = {
      id: 91,
      itemId: 77,
      quantity: 2,
      direction: 'OUT',
      reason: 'RESERVED',
      metadata: {
        checkoutId: 'chk_123',
        version: 1,
        lineId: 'ln_1',
        expiresAt: '2026-08-03T18:45:00.000Z',
      },
    };

    mockMovementFindMany
      .mockResolvedValueOnce([reservedMovement])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockMovementCreate.mockResolvedValue({ id: 202 });

    const { releaseStock } = require('@/inventory/services/stockReleaseService') as {
      releaseStock: (input: {
        checkoutId: string;
        version: number;
        cause: string;
        lines: Array<{ lineId: string }>;
      }) => Promise<unknown>;
    };

    await expect(
      releaseStock({
        checkoutId: 'chk_123',
        version: 1,
        cause: 'payment_failed',
        lines: [{ lineId: 'ln_1' }],
      }),
    ).resolves.toEqual({
      lines: [{ lineId: 'ln_1', reservedMovementId: 91, cause: 'payment_failed' }],
    });

    expect(mockMovementCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        itemId: 77,
        quantity: 2,
        direction: 'IN',
        reason: 'RELEASED',
        metadata: expect.objectContaining({
          checkoutId: 'chk_123',
          version: 1,
          lineId: 'ln_1',
          reservedMovementId: 91,
          cause: 'payment_failed',
        }),
      }),
    });
  });

  it('expires stale active reservations through the sweeper', async () => {
    const staleReservedMovement = {
      id: 91,
      itemId: 77,
      quantity: 2,
      direction: 'OUT',
      reason: 'RESERVED',
      metadata: {
        checkoutId: 'chk_123',
        version: 1,
        lineId: 'ln_1',
        expiresAt: '2026-08-03T18:00:00.000Z',
      },
    };

    mockMovementFindMany
      .mockResolvedValueOnce([staleReservedMovement])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockMovementCreate.mockResolvedValue({ id: 203 });

    const { expireStockReservations } = require('@/inventory/services/stockReservationExpiryService') as {
      expireStockReservations: (input?: { now?: Date }) => Promise<unknown>;
    };

    await expect(
      expireStockReservations({
        now: new Date('2026-08-03T18:30:00.000Z'),
      }),
    ).resolves.toEqual({
      expiredReservationCount: 1,
      lines: [{ lineId: 'ln_1', reservedMovementId: 91, cause: 'expired' }],
    });

    expect(mockMovementCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        itemId: 77,
        quantity: 2,
        direction: 'IN',
        reason: 'RELEASED',
        metadata: expect.objectContaining({
          checkoutId: 'chk_123',
          version: 1,
          lineId: 'ln_1',
          reservedMovementId: 91,
          cause: 'expired',
        }),
      }),
    });
  });
});
