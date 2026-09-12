import { beforeEach, expect, it, jest } from '@jest/globals';
import { reservationOwnerEventFixture } from '../../helpers/reservationOwnerEventFixture';
import type { InventoryStockTransaction } from '@/inventory/services/stockReservationShared';
const observe = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('@/inventory/services/inventoryReserveScopeService', () => ({
  observeReserveScopeInTransaction: (...args: any[]) => observe(...args),
}));
import { persistReservationExpiryEventInTransaction } from '@/inventory/services/workflows/inventoryOwnerEventService';
const create = jest.fn<(...args: any[]) => Promise<any>>();
const outbox = jest.fn<(...args: any[]) => Promise<any>>();
const tx = {
  inventoryOwnerEvent: { create },
  inventoryOwnerEventOutbox: { create: outbox },
} as unknown as InventoryStockTransaction;
let event: ReturnType<typeof reservationOwnerEventFixture>;
const input = () => ({
  checkoutId: event.resourceId,
  version: event.resourceVersion,
  scope: event.reservation.scope,
  expiredReservationIds: event.expiredReservationIds,
});
beforeEach(() => {
  jest.clearAllMocks();
  event = reservationOwnerEventFixture();
  observe.mockImplementation(async () => ({
    evidenceKind: 'CURRENT_RESERVATION',
    observedAt: event.observedAt,
    reservation: event.reservation,
  }));
  create.mockResolvedValue({ id: 'scope:revision:2' });
  outbox.mockResolvedValue({});
});
it('persists full fresh scope evidence and a separate owner delivery without command receipts', async () => {
  await persistReservationExpiryEventInTransaction(tx, input());
  expect(create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      id: event.eventId,
      scopeId: 'scope',
      scopeRevision: 2,
      checkoutId: 'checkout',
      checkoutVersion: 1,
      kind: event.eventKind,
      observedAt: new Date(event.observedAt),
      payload: event,
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }),
  });
  expect(outbox).toHaveBeenCalledWith({ data: { eventId: event.eventId } });
  expect(create.mock.invocationCallOrder[0]).toBeLessThan(outbox.mock.invocationCallOrder[0]);
});
it.each([null, { evidenceKind: 'CLOSED_NO_EFFECT' }])(
  'rejects unavailable full current evidence',
  async (observation) => {
    observe.mockResolvedValue(observation);
    await expect(persistReservationExpiryEventInTransaction(tx, input())).rejects.toThrow(
      'INVENTORY_OWNER_EVENT_INVALID',
    );
    expect(create).not.toHaveBeenCalled();
  },
);
it.each(['id', 'revision'])(
  'rejects scope %s changed from the just-persisted transition',
  async (key) => {
    const request = input();
    request.scope = { ...request.scope, [key]: key === 'id' ? 'other' : 3 };
    await expect(persistReservationExpiryEventInTransaction(tx, request)).rejects.toThrow(
      'INVENTORY_OWNER_EVENT_INVALID',
    );
    expect(create).not.toHaveBeenCalled();
  },
);
it('does not silently convert duplicate transition IDs into a valid event', async () => {
  await expect(
    persistReservationExpiryEventInTransaction(tx, {
      ...input(),
      expiredReservationIds: ['hold-a', 'hold-a'],
    }),
  ).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
});
it('orders actual transitioned IDs while retaining already terminal lines only in evidence', async () => {
  Object.assign(event.reservation.lines[1], {
    state: 'EXPIRED',
    revision: 1,
    releasedMovementId: 4,
  });
  await persistReservationExpiryEventInTransaction(tx, {
    ...input(),
    expiredReservationIds: ['hold-b', 'hold-a'],
  });
  expect(create.mock.calls[0][0].data.payload.expiredReservationIds).toEqual(['hold-a', 'hold-b']);
});
it.each(['observation', 'event', 'outbox'])(
  'propagates %s failure for enclosing expiry rollback',
  async (stage) => {
    ({ observation: observe, event: create, outbox })[stage as 'event'].mockRejectedValueOnce(
      new Error('fault'),
    );
    await expect(persistReservationExpiryEventInTransaction(tx, input())).rejects.toThrow('fault');
  },
);
