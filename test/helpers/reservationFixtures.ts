// Explicit synthetic hold policy for isolated tests; never imported by runtime services.
export const SYNTHETIC_HOLD_DURATION_MS = 15 * 60 * 1000;
export const reservationScopeFixture = (revision = 1) => ({
  id: 'reserve-scope',
  revision,
  reserveOperationId: 'reserve',
  reserveOperationInputHash: 'a'.repeat(64),
  reserveInputHash: 'b'.repeat(64),
});
import type { ReservationRecord } from '@/inventory/services/stockReservationShared';
import type { ReservationResult } from '@/inventory/types/stockReservationCommands';
export const reservationRecord = (
  overrides: Partial<ReservationRecord> = {},
): ReservationRecord => ({
  id: 'reservation',
  scopeLineId: 'scope-line',
  checkoutId: 'checkout',
  checkoutVersion: 1,
  lineId: 'line',
  itemId: 10,
  state: 'HELD',
  revision: 0,
  expiresAt: new Date('2030-01-01T00:15:00Z'),
  paymentScopeId: null,
  fence: 0,
  paymentId: null,
  purchaseId: null,
  commerceSellerOrderId: null,
  resolutionId: null,
  scopeClosedAt: null,
  releaseCause: null,
  heldMovementId: 20,
  releasedMovementId: null,
  soldMovementId: null,
  createdAt: new Date('2030-01-01'),
  updatedAt: new Date('2030-01-01'),
  heldMovement: {
    id: 20,
    itemId: 10,
    quantity: 1,
    direction: 'OUT',
    reason: 'RESERVED',
    createdAt: new Date('2030-01-01'),
    metadata: null,
    createdBy: null,
  },
  ...overrides,
});
export const reservationResponse = (
  state: ReservationResult['lines'][number]['state'] = 'HELD',
): ReservationResult => ({
  scope: reservationScopeFixture(),
  checkoutId: 'checkout',
  version: 1,
  expiresAt: '2030-01-01T00:15:00.000Z',
  lines: [
    {
      reservationId: 'reservation',
      lineId: 'line',
      quantity: 1,
      revision: 0,
      state,
      expiresAt: '2030-01-01T00:15:00.000Z',
      paymentScopeId: null,
      fence: 0,
      heldMovementId: 20,
      releasedMovementId: null,
      soldMovementId: null,
    },
  ],
});
