import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { InventoryCommandProducer } from '@/constants/inventoryWorkflows';
import { workflowInputHash } from '@/inventory/services/workflows/workflowIdentity';

const fn = <T>(value: T) => jest.fn<(...args: any[]) => Promise<T>>().mockResolvedValue(value);
const tx: any = {
  $queryRaw: fn([]),
  item: { findUnique: fn({ id: 7, deletedAt: null }) },
  movement: { create: fn({ id: 9 }) },
  returnRestockOperation: { findUnique: fn(null), create: fn({}) },
  inventoryCommand: { findUnique: fn(null), create: fn({ state: 'RECEIVED' }), update: fn({}) },
  inventoryInboxEvent: { createMany: fn({ count: 1 }), findUniqueOrThrow: fn({ id: 'receipt-1' }) },
  inventoryResultOutbox: { create: fn({}) },
};
const lockStockItems = jest.fn<(...args: any[]) => Promise<void>>().mockResolvedValue();
jest.mock('@/inventory/services/stockReservationShared', () => ({
  lockStockItems: (...args: any[]) => lockStockItems(...args),
  withStockTransaction: (work: any, _transaction?: any) => work(tx),
}));

import { applyReturnRestock } from '@/inventory/services/returnRestockService';
import { consumeReturnRestockCommand, parseReturnRestockCommand } from '@/inventory/services/workflows/returnRestockCommandService';

const input = () => ({ operationId: 'return:1:restock:v1', returnId: 'return-1', sellerOrderId: 'order-1',
  sellerAccountId: 'seller-1', evidenceHash: 'a'.repeat(64),
  lines: [{ sourceInvId: 'phone-1', commercePurchaseLineId: 'line-1', quantity: 1 }] });
const command = () => {
  const value: any = { type: 'WORKFLOW_COMMAND', schemaVersion: 1, producer: 'fulfillment',
    command: 'INVENTORY_APPLY_RETURN', eventId: 'event-1', operationId: 'return:1:restock:v1',
    executionId: 'execution-1', correlationId: 'correlation-1', operationInputHash: '',
    workflowKind: 'RETURN_RESTOCK', stepKey: 'INVENTORY_APPLY_RETURN', participantKey: 'inventory:seller-1',
    resourceType: 'return', resourceId: 'return-1', resourceVersion: 1,
    actorIdentifier: 'seller-1', deadlineAt: '2030-01-01T00:00:00.000Z',
    input: { returnId: 'return-1', sellerOrderId: 'order-1', sellerAccountId: 'seller-1',
      evidenceHash: 'a'.repeat(64), lines: [{ sourceInvId: 'phone-1', commercePurchaseLineId: 'line-1', quantity: 1 }] } };
  value.operationInputHash = workflowInputHash({ kind: value.workflowKind, resourceType: value.resourceType,
    resourceId: value.resourceId, resourceVersion: value.resourceVersion, stepKey: value.stepKey,
    participantKey: value.participantKey, input: value.input, deadlineAt: value.deadlineAt });
  return value;
};

beforeEach(() => {
  jest.clearAllMocks();
  tx.item.findUnique.mockResolvedValue({ id: 7, deletedAt: null });
  tx.movement.create.mockResolvedValue({ id: 9 });
  tx.returnRestockOperation.findUnique.mockResolvedValue(null);
  tx.inventoryCommand.findUnique.mockResolvedValue(null);
  tx.inventoryCommand.create.mockResolvedValue({ state: 'RECEIVED' });
  tx.inventoryInboxEvent.createMany.mockResolvedValue({ count: 1 });
  tx.inventoryInboxEvent.findUniqueOrThrow.mockResolvedValue({ id: 'receipt-1', operationId: 'return:1:restock:v1' });
});

describe('return inventory effect', () => {
  it('resolves stock, records returned movement and supports an explicit transaction', async () => {
    await expect(applyReturnRestock(input(), tx)).resolves.toEqual({ returnId: 'return-1', sellerOrderId: 'order-1',
      evidenceHash: 'a'.repeat(64), lines: [{ commercePurchaseLineId: 'line-1', itemId: 7, movementId: 9, quantity: 1 }] });
    expect(lockStockItems).toHaveBeenCalledWith(tx, [7]);
    expect(tx.returnRestockOperation.create).toHaveBeenCalledTimes(1);
  });

  it('replays matching evidence and rejects conflicting evidence', async () => {
    const value = input();
    const result = { returnId: value.returnId, sellerOrderId: value.sellerOrderId, evidenceHash: value.evidenceHash,
      lines: [{ commercePurchaseLineId: 'line-1', itemId: 7, movementId: 9, quantity: 1 }] };
    tx.returnRestockOperation.findUnique.mockResolvedValue({ inputHash: workflowInputHash(value), result });
    await expect(applyReturnRestock(value)).resolves.toEqual(result);
    tx.returnRestockOperation.findUnique.mockResolvedValue({ inputHash: 'different', result });
    await expect(applyReturnRestock(value)).rejects.toThrow('RETURN_RESTOCK_IDEMPOTENCY_CONFLICT');
  });

  it.each([null, { id: 7, deletedAt: new Date() }])('rejects absent or deleted stock %j', async item => {
    tx.item.findUnique.mockResolvedValue(item);
    await expect(applyReturnRestock(input())).rejects.toThrow('RETURN_RESTOCK_ITEM_NOT_FOUND');
  });
});

describe('return restock command receipt', () => {
  it('validates every immutable scope binding', () => {
    expect(parseReturnRestockCommand(command())).toMatchObject({ resourceId: 'return-1' });
    for (const change of [{ resourceId: 'other' }, { participantKey: 'other' },
      { operationInputHash: '0'.repeat(64) }])
      expect(() => parseReturnRestockCommand({ ...command(), ...change })).toThrow();
  });

  it('writes a durable command, effect, result and terminal state', async () => {
    const value = command();
    tx.inventoryInboxEvent.findUniqueOrThrow.mockResolvedValue({ id: 'receipt-1',
      operationId: value.operationId, payloadHash: workflowInputHash(value) });
    await expect(consumeReturnRestockCommand(value, InventoryCommandProducer.fulfillment))
      .resolves.toMatchObject({ outcome: 'SUCCEEDED', resourceId: 'return-1' });
    expect(tx.inventoryResultOutbox.create).toHaveBeenCalledTimes(1);
    expect(tx.inventoryCommand.update).toHaveBeenCalledTimes(1);
  });

  it('enforces producer, envelope, receipt and terminal state', async () => {
    const value = command(); const { eventId: _eventId, ...immutable } = value;
    expect(() => consumeReturnRestockCommand(value, InventoryCommandProducer.commerce))
      .toThrow('INVENTORY_COMMAND_SOURCE_MISMATCH');
    tx.inventoryCommand.findUnique.mockResolvedValueOnce({ state: 'RECEIVED', envelopeHash: 'different' });
    await expect(consumeReturnRestockCommand(value, InventoryCommandProducer.fulfillment))
      .rejects.toThrow('INVENTORY_COMMAND_ENVELOPE_CONFLICT');
    tx.inventoryCommand.findUnique.mockResolvedValueOnce({ state: 'RECEIVED', envelopeHash: workflowInputHash(immutable) });
    tx.inventoryInboxEvent.findUniqueOrThrow.mockResolvedValueOnce({ operationId: 'other', payloadHash: workflowInputHash(value) });
    await expect(consumeReturnRestockCommand(value, InventoryCommandProducer.fulfillment))
      .rejects.toThrow('INVENTORY_INBOX_CONFLICT');
    tx.inventoryCommand.findUnique.mockResolvedValueOnce({ state: 'FAILED', envelopeHash: workflowInputHash(immutable) });
    tx.inventoryInboxEvent.findUniqueOrThrow.mockResolvedValueOnce({ operationId: value.operationId, payloadHash: workflowInputHash(value) });
    await expect(consumeReturnRestockCommand(value, InventoryCommandProducer.fulfillment))
      .rejects.toThrow('RETURN_RESTOCK_COMMAND_TERMINAL');
  });

  it('replays a stored result and only redrives it for a new receipt', async () => {
    const value = command(); const { eventId: _eventId, ...immutable } = value;
    const stored = { type: 'WORKFLOW_RESULT', schemaVersion: 1, producer: 'inventory', eventId: `${value.operationId}:result`,
      operationId: value.operationId, executionId: value.executionId, correlationId: value.correlationId,
      operationInputHash: value.operationInputHash, resourceType: 'return', resourceId: 'return-1', resourceVersion: 1,
      outcome: 'SUCCEEDED', result: { returnId: 'return-1', sellerOrderId: 'order-1', evidenceHash: 'a'.repeat(64),
        lines: [{ commercePurchaseLineId: 'line-1', itemId: 7, movementId: 9, quantity: 1 }] } };
    tx.inventoryCommand.findUnique.mockResolvedValue({ state: 'SUCCEEDED', envelopeHash: workflowInputHash(immutable), result: stored });
    tx.inventoryInboxEvent.findUniqueOrThrow.mockResolvedValue({ id: 'receipt-1', operationId: value.operationId,
      payloadHash: workflowInputHash(value) });
    tx.inventoryInboxEvent.createMany.mockResolvedValueOnce({ count: 0 });
    await expect(consumeReturnRestockCommand(value, InventoryCommandProducer.fulfillment)).resolves.toEqual(stored);
    tx.inventoryInboxEvent.createMany.mockResolvedValueOnce({ count: 1 });
    await expect(consumeReturnRestockCommand(value, InventoryCommandProducer.fulfillment)).resolves.toEqual(stored);
    expect(tx.inventoryResultOutbox.create).toHaveBeenCalledTimes(1);
  });
});
