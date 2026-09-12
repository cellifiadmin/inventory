import type { ReservationResult } from '@/inventory/types/stockReservationCommands';

const reservation = (released: boolean, protectedRelease = true): ReservationResult => ({
  scope: {
    id: 'scope',
    revision: released && !protectedRelease ? 2 : 3,
    reserveOperationId: 'reserve',
    reserveOperationInputHash: 'a'.repeat(64),
    reserveInputHash: 'b'.repeat(64),
  },
  checkoutId: 'checkout',
  version: 1,
  expiresAt: '2030-01-01T00:15:00.000Z',
  lines: [
    {
      reservationId: 'hold-a',
      lineId: 'line-a',
      quantity: 2,
      revision: released && !protectedRelease ? 1 : 2,
      state: released ? 'RELEASED' : 'COMMITTED',
      expiresAt: '2030-01-01T00:15:00.000Z',
      paymentScopeId: released && !protectedRelease ? null : 'parent',
      fence: released ? (protectedRelease ? 2 : 0) : 1,
      heldMovementId: 1,
      releasedMovementId: 2,
      soldMovementId: released ? null : 3,
    },
    {
      reservationId: 'hold-b',
      lineId: 'line-b',
      quantity: 1,
      revision: released && !protectedRelease ? 0 : 1,
      state: released && !protectedRelease ? 'HELD' : 'PAYMENT_LOCKED',
      expiresAt: '2030-01-01T00:15:00.000Z',
      paymentScopeId: released && !protectedRelease ? null : 'parent',
      fence: released && !protectedRelease ? 0 : 1,
      heldMovementId: 4,
      releasedMovementId: null,
      soldMovementId: null,
    },
  ],
});
const common = (value: ReservationResult) => ({
  type: 'WORKFLOW_OWNER_EVENT' as const,
  schemaVersion: 1 as const,
  producer: 'inventory' as const,
  eventId: `${value.scope.id}:revision:${value.scope.revision}`,
  resourceType: 'checkout' as const,
  resourceId: value.checkoutId,
  resourceVersion: value.version,
  observedAt: '2030-01-01T00:01:00.000Z',
  reservation: value,
});
export const committedOwnerEventFixture = () => ({
  ...common(reservation(false)),
  eventKind: 'INVENTORY_RESERVATION_COMMITTED' as const,
  committedReservationIds: ['hold-a'],
  commit: {
    reservationOperationId: 'commit-a',
    paymentId: 'payment',
    purchaseId: 'purchase',
    commerceSellerOrderId: 'seller-order-a',
    paymentScopeId: 'parent',
    fence: 1,
  },
});
export const releasedOwnerEventFixture = (protectedRelease = true) => ({
  ...common(reservation(true, protectedRelease)),
  eventKind: 'INVENTORY_RESERVATION_RELEASED' as const,
  releasedReservationIds: ['hold-a'],
  release: {
    reservationOperationId: 'release-a',
    cause: 'payment_failed' as 'payment_failed' | 'cancelled',
    financialResolution: protectedRelease
      ? {
          resolutionId: 'closure',
          paymentScopeId: 'parent',
          fence: 2,
          scopeClosedAt: '2030-01-01T00:00:30.000Z',
          outcome: 'FAILED' as const,
        }
      : null,
  },
});
