import { expect, it } from '@jest/globals';
import { inventoryOwnerEventSchema } from '@/inventory/types/inventoryOwnerEvent';
import {
  committedOwnerEventFixture,
  releasedOwnerEventFixture,
} from '../../helpers/reservationTerminalOwnerEventFixture';

it('accepts actual committed subset evidence before hold expiry, retaining every original scope line', () => {
  const event = committedOwnerEventFixture();
  expect(inventoryOwnerEventSchema.parse(event)).toEqual(event);
});
it.each([true, false])(
  'accepts owner release evidence, protected=%s, without a fictitious result receipt',
  (protectedRelease) => {
    const event = releasedOwnerEventFixture(protectedRelease);
    expect(inventoryOwnerEventSchema.parse(event)).toEqual(event);
  },
);
it('preserves a cancelled release cause', () => {
  const event = releasedOwnerEventFixture();
  event.release.cause = 'cancelled';
  expect(inventoryOwnerEventSchema.parse(event)).toEqual(event);
});
it.each([
  'paymentId',
  'purchaseId',
  'commerceSellerOrderId',
  'paymentScopeId',
  'reservationOperationId',
] as const)('requires committed %s identity', (key) => {
  const event = committedOwnerEventFixture();
  event.commit[key] = '';
  expect(inventoryOwnerEventSchema.safeParse(event).success).toBe(false);
});
it.each([
  (e: ReturnType<typeof committedOwnerEventFixture>) => {
    e.committedReservationIds = [];
  },
  (e: ReturnType<typeof committedOwnerEventFixture>) => {
    e.committedReservationIds = ['hold-a', 'hold-a'];
  },
  (e: ReturnType<typeof committedOwnerEventFixture>) => {
    e.committedReservationIds = ['hold-b'];
  },
  (e: ReturnType<typeof committedOwnerEventFixture>) => {
    e.committedReservationIds = ['absent'];
  },
  (e: ReturnType<typeof committedOwnerEventFixture>) => {
    e.commit.paymentScopeId = 'substituted';
  },
  (e: ReturnType<typeof committedOwnerEventFixture>) => {
    e.commit.fence = 2;
  },
  (e: ReturnType<typeof committedOwnerEventFixture>) => {
    e.reservation.lines[0].soldMovementId = null;
  },
  (e: ReturnType<typeof committedOwnerEventFixture>) => {
    e.reservation.lines[0].releasedMovementId = 1;
  },
  (e: ReturnType<typeof committedOwnerEventFixture>) => {
    e.reservation.lines[0].revision = 1;
  },
  (e: ReturnType<typeof committedOwnerEventFixture>) => {
    e.eventId = 'another';
  },
])('rejects inconsistent commit transition facts', (change) => {
  const event = committedOwnerEventFixture();
  change(event);
  expect(inventoryOwnerEventSchema.safeParse(event).success).toBe(false);
});
it.each([
  (e: ReturnType<typeof releasedOwnerEventFixture>) => {
    e.releasedReservationIds = [];
  },
  (e: ReturnType<typeof releasedOwnerEventFixture>) => {
    e.releasedReservationIds = ['hold-b'];
  },
  (e: ReturnType<typeof releasedOwnerEventFixture>) => {
    e.release.financialResolution = null;
  },
  (e: ReturnType<typeof releasedOwnerEventFixture>) => {
    e.release.financialResolution!.paymentScopeId = 'substituted';
  },
  (e: ReturnType<typeof releasedOwnerEventFixture>) => {
    e.release.financialResolution!.fence = 1;
  },
  (e: ReturnType<typeof releasedOwnerEventFixture>) => {
    e.release.financialResolution!.scopeClosedAt = '2030-01-01T00:02:00.000Z';
  },
  (e: ReturnType<typeof releasedOwnerEventFixture>) => {
    e.reservation.lines[0].soldMovementId = 3;
  },
  (e: ReturnType<typeof releasedOwnerEventFixture>) => {
    e.reservation.lines[0].releasedMovementId = null;
  },
])('rejects invalid protected release evidence', (change) => {
  const event = releasedOwnerEventFixture();
  change(event);
  expect(inventoryOwnerEventSchema.safeParse(event).success).toBe(false);
});
it('rejects command and receipt fields on a terminal owner fact', () => {
  const event = committedOwnerEventFixture();
  for (const field of ['operationId', 'executionId', 'receiptId'])
    expect(inventoryOwnerEventSchema.safeParse({ ...event, [field]: 'invented' }).success).toBe(
      false,
    );
});
it('requires canonical changed-ID ordering while retaining unrelated prior terminal facts', () => {
  const event = committedOwnerEventFixture();
  Object.assign(event.reservation.lines[1], {
    state: 'COMMITTED',
    revision: 2,
    releasedMovementId: 5,
    soldMovementId: 6,
  });
  expect(inventoryOwnerEventSchema.parse(event)).toEqual(event);
  event.committedReservationIds = ['hold-b', 'hold-a'];
  expect(inventoryOwnerEventSchema.safeParse(event).success).toBe(false);
  event.committedReservationIds.reverse();
  expect(inventoryOwnerEventSchema.parse(event)).toEqual(event);
});
