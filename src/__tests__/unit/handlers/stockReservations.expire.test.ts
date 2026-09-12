import { reservationResponse } from '../../../../test/helpers/reservationFixtures';
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
        { ...reservationResponse('EXPIRED').lines[0], reservationId: 'first', lineId: 'ln_1' },
        { ...reservationResponse('EXPIRED').lines[0], reservationId: 'second', lineId: 'ln_2' },
      ],
    });

    const { handler } = require('@/handlers/scheduled/stock-reservations/expire') as {
      handler: () => Promise<unknown>;
    };

    await expect(handler()).resolves.toEqual({
      expiredReservationCount: 2,
      lines: [
        { ...reservationResponse('EXPIRED').lines[0], reservationId: 'first', lineId: 'ln_1' },
        { ...reservationResponse('EXPIRED').lines[0], reservationId: 'second', lineId: 'ln_2' },
      ],
    });
    expect(mockExpireStockReservations).toHaveBeenCalledWith();
  });
});
