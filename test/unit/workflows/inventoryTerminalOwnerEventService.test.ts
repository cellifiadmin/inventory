import { beforeEach, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import {
  committedOwnerEventFixture,
  releasedOwnerEventFixture,
} from '../../helpers/reservationTerminalOwnerEventFixture';
import { commitStockSchema, releaseStockSchema } from '@/inventory/types/stockReservationCommands';
import type { InventoryStockTransaction } from '@/inventory/services/stockReservationShared';
const observe = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock('@/inventory/services/inventoryReserveScopeService', () => ({
  observeReserveScopeInTransaction: (...args: unknown[]) => observe(...args),
}));
import { persistReservationTerminalEventInTransaction as persist } from '@/inventory/services/workflows/inventoryTerminalOwnerEventService';
const find = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const create = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const outbox = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const tx = {
  reservationOperation: { findUniqueOrThrow: find },
  inventoryOwnerEvent: { create },
  inventoryOwnerEventOutbox: { create: outbox },
} as unknown as InventoryStockTransaction;
const setup = (released = false, protectedRelease = true) => {
  const event = released
    ? releasedOwnerEventFixture(protectedRelease)
    : committedOwnerEventFixture();
  const lines = [
    {
      reservationId: 'hold-a',
      lineId: 'line-a',
      revision: released && !protectedRelease ? 0 : 1,
    },
  ];
  const input = released
    ? releaseStockSchema.parse({
        operationId: 'release-a',
        checkoutId: 'checkout',
        version: 1,
        lines,
        cause: 'payment_failed',
        ...(protectedRelease
          ? {
              financialResolution: releasedOwnerEventFixture().release.financialResolution,
            }
          : {}),
      })
    : commitStockSchema.parse({
        operationId: 'commit-a',
        checkoutId: 'checkout',
        version: 1,
        scope: { ...event.reservation.scope, revision: 2 },
        paymentId: 'payment',
        purchaseId: 'purchase',
        commerceSellerOrderId: 'seller-order-a',
        paymentScopeId: 'parent',
        fence: 1,
        lines,
      });
  const operation = {
    id: input.operationId,
    kind: released ? 'RELEASE' : 'COMMIT',
    checkoutId: 'checkout',
    checkoutVersion: 1,
    input,
    inputFingerprint: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    result: { ...event.reservation, lines: [event.reservation.lines[0]] },
  };
  find.mockResolvedValue(operation);
  observe.mockResolvedValue({
    evidenceKind: 'CURRENT_RESERVATION',
    observedAt: event.observedAt,
    reservation: event.reservation,
  });
  create.mockResolvedValue({ id: event.eventId });
  outbox.mockResolvedValue({});
  return { event, operation, input: { reservationOperationId: operation.id } };
};
beforeEach(() => {
  jest.clearAllMocks();
});
it.each([false, true])(
  'persists actual terminal operation and full scope with separate owner delivery, release=%s',
  async (released) => {
    const f = setup(released);
    await persist(tx, f.input);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: f.event.eventId,
        kind: f.event.eventKind,
        scopeRevision: 3,
        payload: f.event,
        payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    });
    expect(outbox).toHaveBeenCalledWith({ data: { eventId: f.event.eventId } });
    expect(create.mock.invocationCallOrder[0]).toBeLessThan(outbox.mock.invocationCallOrder[0]);
  },
);
it('emits null financial resolution for an ordinary hold release', async () => {
  const f = setup(true, false);
  await persist(tx, f.input);
  expect(create).toHaveBeenCalledWith({
    data: expect.objectContaining({ payload: f.event }),
  });
});
it.each(['id', 'kind', 'checkoutId', 'checkoutVersion', 'inputFingerprint'] as const)(
  'rejects changed persisted operation %s',
  async (key) => {
    const f = setup();
    Object.assign(f.operation, {
      [key]: key === 'checkoutVersion' ? 9 : 'other',
    });
    await expect(persist(tx, f.input)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  },
);
it.each([
  'id',
  'revision',
  'reserveOperationId',
  'reserveOperationInputHash',
  'reserveInputHash',
] as const)('rejects a changed observed original scope %s', async (key) => {
  const f = setup();
  f.event.reservation.scope = {
    ...f.event.reservation.scope,
    [key]: key === 'revision' ? 4 : 'other',
  };
  await expect(persist(tx, f.input)).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
});
it.each([null, { evidenceKind: 'CLOSED_NO_EFFECT' }])(
  'rejects missing materialized full scope evidence',
  async (value) => {
    const f = setup();
    observe.mockResolvedValue(value);
    await expect(persist(tx, f.input)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  },
);
it('rejects a persisted result with another transition subset', async () => {
  const f = setup();
  f.operation.result.lines = [];
  await expect(persist(tx, f.input)).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
});
it('rejects a result that does not advance its input line revision exactly once', async () => {
  const f = setup();
  f.operation.result.lines = [{ ...f.operation.result.lines[0], revision: 1 }];
  await expect(persist(tx, f.input)).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
});
it('rejects changed full-snapshot movement lineage', async () => {
  const f = setup();
  f.event.reservation.lines[0] = {
    ...f.event.reservation.lines[0],
    soldMovementId: 9,
  };
  await expect(persist(tx, f.input)).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
});
it.each(['operation', 'observation', 'event', 'outbox'])(
  'propagates %s failure for enclosing domain rollback',
  async (stage) => {
    const f = setup();
    ({ operation: find, observation: observe, event: create, outbox })[
      stage as 'event'
    ].mockRejectedValueOnce(Error('fault'));
    await expect(persist(tx, f.input)).rejects.toThrow('fault');
  },
);
it.each([
  'id',
  'reserveOperationId',
  'reserveOperationInputHash',
  'reserveInputHash',
  'revision',
] as const)('rejects a rehashed commit input that substitutes protected scope %s', async (key) => {
  const f = setup();
  if (!('scope' in f.operation.input)) throw Error('Expected commit input');
  f.operation.input.scope = {
    ...f.operation.input.scope,
    [key]: key === 'revision' ? 3 : key.includes('Hash') ? 'c'.repeat(64) : 'substituted',
  };
  f.operation.inputFingerprint = createHash('sha256')
    .update(JSON.stringify(f.operation.input))
    .digest('hex');
  await expect(persist(tx, f.input)).rejects.toThrow('INVENTORY_OWNER_EVENT_INVALID');
  expect(create).not.toHaveBeenCalled();
});
it('serializes an accepted closure timestamp canonically without changing its stored operation fingerprint', async () => {
  const f = setup(true);
  if (!('financialResolution' in f.operation.input) || !f.operation.input.financialResolution)
    throw Error('Expected release proof');
  f.operation.input.financialResolution.scopeClosedAt = '2030-01-01T00:00:30Z';
  f.operation.inputFingerprint = createHash('sha256')
    .update(JSON.stringify(f.operation.input))
    .digest('hex');
  await persist(tx, f.input);
  expect(create).toHaveBeenCalledWith({
    data: expect.objectContaining({ payload: f.event }),
  });
});
