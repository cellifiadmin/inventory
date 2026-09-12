import { describe, expect, it } from '@jest/globals';
import { inventoryOwnerEventSchema } from '@/inventory/types/inventoryOwnerEvent';
import { reservationOwnerEventFixture } from '../../helpers/reservationOwnerEventFixture';

describe('strict owner-origin reservation expiry event', () => {
  it('accepts a complete mixed snapshot and the exact newly expired subset', () => {
    const event = reservationOwnerEventFixture();
    expect(inventoryOwnerEventSchema.parse(event)).toEqual(event);
  });
  it.each([
    (e: any) => {
      e.type = 'WORKFLOW_RESULT';
    },
    (e: any) => {
      e.producer = 'commerce';
    },
    (e: any) => {
      e.eventKind = 'OTHER';
    },
    (e: any) => {
      e.operationId = 'fabricated-command';
    },
    (e: any) => {
      e.receiptId = 'fabricated-receipt';
    },
    (e: any) => {
      e.eventId = 'wrong';
    },
    (e: any) => {
      e.resourceId = 'other';
    },
    (e: any) => {
      e.resourceVersion = 2;
    },
    (e: any) => {
      e.observedAt = '2030-01-02T00:00:00Z';
    },
    (e: any) => {
      e.observedAt = '2029-01-01T00:00:00.000Z';
    },
    (e: any) => {
      e.reservation.expiresAt = '2030-01-01T00:00:00Z';
    },
    (e: any) => {
      e.reservation.lines[0].expiresAt = '2030-01-03T00:00:00.000Z';
    },
    (e: any) => {
      e.expiredReservationIds = [];
    },
    (e: any) => {
      e.expiredReservationIds = ['missing'];
    },
    (e: any) => {
      e.expiredReservationIds = ['hold-b'];
    },
    (e: any) => {
      e.expiredReservationIds.push(e.expiredReservationIds[0]);
    },
    (e: any) => {
      e.reservation.lines[1].reservationId = e.reservation.lines[0].reservationId;
    },
    (e: any) => {
      e.reservation.lines[1].lineId = e.reservation.lines[0].lineId;
    },
    (e: any) => {
      e.reservation.lines[1].heldMovementId = e.reservation.lines[0].heldMovementId;
    },
    (e: any) => {
      e.reservation.lines[0].releasedMovementId = e.reservation.lines[0].heldMovementId;
    },
    (e: any) => {
      e.reservation.lines[0].releasedMovementId = null;
    },
    (e: any) => {
      e.reservation.lines[0].soldMovementId = 55;
    },
    (e: any) => {
      e.reservation.lines[0].paymentScopeId = 'protected';
    },
    (e: any) => {
      e.reservation.lines[0].fence = 1;
    },
    (e: any) => {
      e.reservation.lines[0].revision = 2;
    },
    (e: any) => {
      e.reservation.lines[1].releasedMovementId = 55;
    },
    (e: any) => {
      e.reservation.lines[1].paymentScopeId = 'protected';
    },
    (e: any) => {
      e.reservation.lines[1].fence = 1;
    },
    (e: any) => {
      e.reservation.lines[1].revision = 1;
    },
  ])('rejects altered event identity, partial or inconsistent lineage', (change) => {
    const event = reservationOwnerEventFixture();
    change(event);
    expect(inventoryOwnerEventSchema.safeParse(event).success).toBe(false);
  });
  it('rejects a snapshot exceeding the bounded transport payload size', () => {
    const event = reservationOwnerEventFixture();
    event.reservation.lines[0].lineId = 'x'.repeat(262144);
    expect(inventoryOwnerEventSchema.safeParse(event).success).toBe(false);
  });
  it('requires transitioned IDs to have canonical ordering', () => {
    const event = reservationOwnerEventFixture();
    const other = event.reservation.lines[1];
    Object.assign(other, { state: 'EXPIRED', revision: 1, releasedMovementId: 4 });
    event.expiredReservationIds = ['hold-b', 'hold-a'];
    expect(inventoryOwnerEventSchema.safeParse(event).success).toBe(false);
    event.expiredReservationIds.reverse();
    expect(inventoryOwnerEventSchema.safeParse(event).success).toBe(true);
  });
  it.each([
    { state: 'PAYMENT_LOCKED', revision: 1, paymentScopeId: 'parent', fence: 1 },
    {
      state: 'COMMITTED',
      revision: 2,
      paymentScopeId: 'parent',
      fence: 1,
      releasedMovementId: 4,
      soldMovementId: 5,
    },
    { state: 'RELEASED', revision: 1, releasedMovementId: 4 },
    { state: 'RELEASED', revision: 2, paymentScopeId: 'parent', fence: 2, releasedMovementId: 4 },
  ])('retains valid other-line state $state in full scope snapshots', (state) => {
    const event = reservationOwnerEventFixture();
    Object.assign(event.reservation.lines[1], state);
    expect(inventoryOwnerEventSchema.safeParse(event).success).toBe(true);
    event.reservation.lines[1].revision = 9;
    expect(inventoryOwnerEventSchema.safeParse(event).success).toBe(false);
  });
});
