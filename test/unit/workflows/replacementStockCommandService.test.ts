import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { InventoryCommandProducer } from '@/constants/inventoryWorkflows';
import { workflowInputHash } from '@/inventory/services/workflows/workflowIdentity';

const mockReserve = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockTransition = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const now = new Date('2030-01-01T00:00:00.000Z');
const makeTx = () => ({
  $queryRaw: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue([]),
  inventoryCommand: { findUnique: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(null),
    create: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockImplementation(async arg => ({ ...(arg as { data: object }).data, state: 'RECEIVED' })),
    update: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({}) },
  inventoryInboxEvent: { createMany: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ count: 1 }),
    findUniqueOrThrow: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ id: 'receipt', operationId: 'replacement:shipment:reserve:v1', payloadHash: '' }) },
  inventoryResultOutbox: { create: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({}) },
});
let db = makeTx();
jest.mock('@/inventory/services/stockReservationShared', () => ({
  databaseNow: async () => now,
  withStockTransaction: (work: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => work(db),
}));
jest.mock('@/inventory/services/replacementStockService', () => {
  const actual = jest.requireActual<typeof import('@/inventory/services/replacementStockService')>('@/inventory/services/replacementStockService');
  return { ...actual, reserveReplacementStock: (...args: unknown[]) => mockReserve(...args),
    transitionReplacementStock: (...args: unknown[]) => mockTransition(...args) };
});
import { consumeReplacementStockCommand } from '@/inventory/services/workflows/replacementStockCommandService';
const reserveInput = () => ({ shipmentId: 'shipment', entitlementId: 'entitlement',
  sellerOrderId: 'seller-order', sellerAccountId: 'seller', purchaseId: 'purchase',
  commerceSellerOrderId: 'commercial-order', commercePurchaseLineId: 'line',
  sourceInvId: 'item', quantity: 2 });
const event = (command: 'INVENTORY_RESERVE_REPLACEMENT' | 'INVENTORY_COMMIT_REPLACEMENT' | 'INVENTORY_RELEASE_REPLACEMENT' = 'INVENTORY_RESERVE_REPLACEMENT') => {
  const phase = command === 'INVENTORY_RESERVE_REPLACEMENT' ? 'reserve'
    : command === 'INVENTORY_COMMIT_REPLACEMENT' ? 'commit' : 'release';
  const input = phase === 'reserve' ? reserveInput() : { ...reserveInput(),
    holdOperationId: 'replacement:shipment:reserve:v1', itemId: 7, heldMovementId: 8 };
  const value = { type: 'WORKFLOW_COMMAND', schemaVersion: 1, producer: InventoryCommandProducer.fulfillment,
    command, eventId: 'delivery', operationId: `replacement:shipment:${phase}:v1`,
    executionId: 'replacement:shipment', correlationId: 'seller-order',
    workflowKind: 'REPLACEMENT_STOCK', stepKey: command, participantKey: 'inventory:seller',
    resourceType: 'replacement-shipment', resourceId: 'shipment', resourceVersion: 1,
    actorIdentifier: 'seller', deadlineAt: '2030-01-02T00:00:00.000Z', input };
  return { ...value, operationInputHash: workflowInputHash({ kind: value.workflowKind,
    resourceType: value.resourceType, resourceId: value.resourceId,
    resourceVersion: value.resourceVersion, stepKey: value.stepKey,
    participantKey: value.participantKey, input: value.input, deadlineAt: value.deadlineAt }) };
};
const accepted = (value: ReturnType<typeof event>) => {
  db.inventoryInboxEvent.findUniqueOrThrow.mockResolvedValue({ id: 'receipt', operationId: value.operationId,
    payloadHash: workflowInputHash(value) });
};
const result = () => ({ shipmentId: 'shipment', entitlementId: 'entitlement', sellerOrderId: 'seller-order',
  itemId: 7, heldMovementId: 8, quantity: 2 });
beforeEach(() => {
  db = makeTx();
  mockReserve.mockReset().mockResolvedValue(result());
  mockTransition.mockReset().mockResolvedValue({ ...result(), releasedMovementId: 9,
    soldMovementId: 10, phase: 'COMMIT' });
});

describe('replacement stock command envelope', () => {
  it.each(['INVENTORY_RESERVE_REPLACEMENT', 'INVENTORY_COMMIT_REPLACEMENT', 'INVENTORY_RELEASE_REPLACEMENT'] as const)(
    'accepts exact %s and retains its outcome', async command => {
      const value = event(command); accepted(value);
      if (command === 'INVENTORY_RELEASE_REPLACEMENT') mockTransition.mockResolvedValue({ ...result(),
        releasedMovementId: 9, soldMovementId: null, phase: 'RELEASE' });
      const response = await consumeReplacementStockCommand(value, InventoryCommandProducer.fulfillment);
      expect(response).toMatchObject({ outcome: 'SUCCEEDED', operationId: value.operationId });
      expect(db.inventoryCommand.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ state: 'SUCCEEDED' }),
      }));
      expect(db.inventoryResultOutbox.create).toHaveBeenCalledTimes(1);
    });
  it.each([
    (v: ReturnType<typeof event>) => ({ ...v, stepKey: 'INVENTORY_COMMIT_REPLACEMENT' }),
    (v: ReturnType<typeof event>) => ({ ...v, operationId: 'changed' }),
    (v: ReturnType<typeof event>) => ({ ...v, input: { ...v.input, holdOperationId: 'bad' } }),
    (v: ReturnType<typeof event>) => ({ ...v, resourceId: 'other' }),
    (v: ReturnType<typeof event>) => ({ ...v, executionId: 'other' }),
    (v: ReturnType<typeof event>) => ({ ...v, correlationId: 'other' }),
    (v: ReturnType<typeof event>) => ({ ...v, participantKey: 'other' }),
    (v: ReturnType<typeof event>) => ({ ...v, operationInputHash: 'b'.repeat(64) }),
  ])('rejects tampered scope', async change => {
    await expect(Promise.resolve().then(() => consumeReplacementStockCommand(change(event()), InventoryCommandProducer.fulfillment))).rejects.toThrow();
  });
  it('rejects a transition without its exact reserve hold operation', async () => {
    const value = event('INVENTORY_COMMIT_REPLACEMENT');
    await expect(Promise.resolve().then(() => consumeReplacementStockCommand({ ...value,
      input: { ...value.input, holdOperationId: 'other' } }, InventoryCommandProducer.fulfillment))).rejects.toThrow();
  });
  it('rejects untrusted event source before effects', async () => {
    const value = event();
    expect(() => consumeReplacementStockCommand(value, InventoryCommandProducer.commerce)).toThrow('SOURCE_MISMATCH');
    expect(db.inventoryCommand.create).not.toHaveBeenCalled();
  });
});

describe('replacement stock command replay and errors', () => {
  it('rejects a changed immutable envelope or reused event identity', async () => {
    const value = event(); accepted(value);
    db.inventoryCommand.findUnique.mockResolvedValue({ envelopeHash: 'other', state: 'RECEIVED' });
    await expect(consumeReplacementStockCommand(value, InventoryCommandProducer.fulfillment)).rejects.toThrow('ENVELOPE_CONFLICT');
    db.inventoryCommand.findUnique.mockResolvedValue({ envelopeHash: workflowInputHash((({ eventId, ...rest }) => rest)(value)), state: 'RECEIVED' });
    db.inventoryInboxEvent.findUniqueOrThrow.mockResolvedValue({ id: 'receipt', operationId: 'other', payloadHash: workflowInputHash(value) });
    await expect(consumeReplacementStockCommand(value, InventoryCommandProducer.fulfillment)).rejects.toThrow('INBOX_CONFLICT');
    db.inventoryInboxEvent.findUniqueOrThrow.mockResolvedValue({ id: 'receipt', operationId: value.operationId, payloadHash: 'other' });
    await expect(consumeReplacementStockCommand(value, InventoryCommandProducer.fulfillment)).rejects.toThrow('INBOX_CONFLICT');
  });
  it('returns retained terminal result and only emits a new delivery for new event IDs', async () => {
    const value = event(); accepted(value);
    const retained = { type: 'WORKFLOW_RESULT', schemaVersion: 1, producer: 'inventory',
      eventId: `${value.operationId}:result`, operationId: value.operationId,
      executionId: value.executionId, correlationId: value.correlationId,
      operationInputHash: value.operationInputHash, resourceType: value.resourceType,
      resourceId: value.resourceId, resourceVersion: 1, outcome: 'SUCCEEDED', result: result() };
    db.inventoryCommand.findUnique.mockResolvedValue({ envelopeHash: workflowInputHash((({ eventId, ...rest }) => rest)(value)), state: 'SUCCEEDED', result: retained });
    expect(await consumeReplacementStockCommand(value, InventoryCommandProducer.fulfillment)).toMatchObject(retained);
    expect(db.inventoryResultOutbox.create).toHaveBeenCalledTimes(1);
    db.inventoryInboxEvent.createMany.mockResolvedValue({ count: 0 });
    expect(await consumeReplacementStockCommand(value, InventoryCommandProducer.fulfillment)).toMatchObject(retained);
    expect(db.inventoryResultOutbox.create).toHaveBeenCalledTimes(1);
    db.inventoryCommand.findUnique.mockResolvedValue({ envelopeHash: workflowInputHash((({ eventId, ...rest }) => rest)(value)), state: 'UNKNOWN' });
    await expect(consumeReplacementStockCommand(value, InventoryCommandProducer.fulfillment)).rejects.toThrow('COMMAND_TERMINAL');
  });
  it.each(['REPLACEMENT_STOCK_UNAVAILABLE', 'REPLACEMENT_STOCK_DEADLINE_EXPIRED'])(
    'records a bounded no-effect failure for %s', async code => {
      const value = event(); accepted(value);
      if (code === 'REPLACEMENT_STOCK_DEADLINE_EXPIRED') {
        value.deadlineAt = '2029-12-31T00:00:00.000Z';
        value.operationInputHash = workflowInputHash({ kind: value.workflowKind,
          resourceType: value.resourceType, resourceId: value.resourceId,
          resourceVersion: value.resourceVersion, stepKey: value.stepKey,
          participantKey: value.participantKey, input: value.input, deadlineAt: value.deadlineAt });
      }
      else mockReserve.mockRejectedValue(new Error(code));
      accepted(value);
      expect(await consumeReplacementStockCommand(value, InventoryCommandProducer.fulfillment)).toMatchObject({
        outcome: 'FAILED', result: { errorCode: code, recoveryRequired: false, noEffect: null },
      });
    });
  it('does not acknowledge unknown or non-error stock failures as no-effect', async () => {
    const value = event(); accepted(value);
    mockReserve.mockRejectedValue(new Error('DATABASE_UNAVAILABLE'));
    await expect(consumeReplacementStockCommand(value, InventoryCommandProducer.fulfillment)).rejects.toThrow('DATABASE_UNAVAILABLE');
    mockReserve.mockRejectedValue('unknown');
    await expect(consumeReplacementStockCommand(value, InventoryCommandProducer.fulfillment)).rejects.toBe('unknown');
  });
});
