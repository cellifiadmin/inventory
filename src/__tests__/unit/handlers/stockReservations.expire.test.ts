import type { expireStockReservations } from '@/inventory/services/stockReservationExpiryService';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockExpireStockReservations = jest.fn<typeof expireStockReservations>();

jest.mock('@/inventory/services/stockReservationExpiryService', () => ({
  expireStockReservations: (...args: Parameters<typeof expireStockReservations>) => mockExpireStockReservations(...args),
}));

describe('stock reservation expiry handler', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('expires stale stock reservations', async () => {
    mockExpireStockReservations.mockResolvedValue({
      expiredReservationCount: 2,
      lines: [
        { lineId: 'ln_1', reservedMovementId: 11, cause: 'expired' },
        { lineId: 'ln_2', reservedMovementId: 12, cause: 'expired' },
      ],
    });

    const { handler } = require('@/handlers/scheduled/stock-reservations/expire') as {
      handler: () => Promise<unknown>;
    };

    await expect(handler()).resolves.toEqual({
      expiredReservationCount: 2,
      lines: [
        { lineId: 'ln_1', reservedMovementId: 11, cause: 'expired' },
        { lineId: 'ln_2', reservedMovementId: 12, cause: 'expired' },
      ],
    });
    expect(mockExpireStockReservations).toHaveBeenCalledWith();
  });
});
