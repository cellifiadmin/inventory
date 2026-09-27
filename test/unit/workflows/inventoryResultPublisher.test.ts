import { beforeEach, expect, it, jest } from '@jest/globals';
import type { InventoryResultOutbox } from '.prisma/inventoryClient';
import type { SendMessageCommand } from '@aws-sdk/client-sqs';
import { workflowInputHash } from '@/inventory/services/workflows/workflowIdentity';
const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn(() => ({ send: (...args: unknown[]) => mockSend(...args) })),
  SendMessageCommand: jest.fn((input: unknown) => ({ input })),
}));
jest.mock('@/lib/awsClientConfig', () => ({ resolveAwsClientConfig: () => ({}) }));
const asyncMock = <T>(value: T) =>
  jest.fn<(...args: unknown[]) => Promise<T>>().mockResolvedValue(value);
const now = new Date('2030-01-01');
const payload = {
  type: 'WORKFLOW_RESULT',
  schemaVersion: 1,
  producer: 'inventory',
  eventId: 'operation:result',
  operationId: 'operation',
  executionId: 'execution',
  correlationId: 'correlation',
  operationInputHash: 'a'.repeat(64),
  resourceType: 'checkout',
  resourceId: 'checkout',
  resourceVersion: 1,
  outcome: 'FAILED',
  result: { errorCode: 'REJECTED', recoveryRequired: false, noEffect: null },
};
const row = (updates: Partial<InventoryResultOutbox> = {}): InventoryResultOutbox => ({
  id: 'delivery',
  operationId: 'operation',
  receiptId: 'receipt',
  eventId: 'operation:result',
  destination: 'commerce',
  payload,
  payloadHash: workflowInputHash(payload),
  state: 'SENDING',
  attempts: 1,
  nextAttemptAt: now,
  leaseOwner: 'owner',
  leaseExpiresAt: new Date(now.getTime() + 30000),
  fencingToken: 1,
  lastErrorCode: null,
  createdAt: now,
  deliveredAt: null,
  ...updates,
});
const makeTx = () => ({
  $queryRaw: asyncMock<{ id: string }[]>([]),
  inventoryResultOutbox: {
    findUniqueOrThrow: asyncMock(row()),
    update: asyncMock(row()),
    updateMany: asyncMock({ count: 1 }),
  },
  inventoryCommandRecovery: { upsert: asyncMock({}) },
});
let mockTx = makeTx();
jest.mock('@/inventory/services/stockReservationShared', () => ({
  databaseNow: async () => now,
  withStockTransaction: (work: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => work(mockTx),
}));
import {
  claimInventoryResult,
  settleInventoryResult,
  sendInventoryResult,
  publishInventoryResults,
} from '@/inventory/services/workflows/inventoryResultPublisher';
import { handler } from '@/handlers/scheduled/reservation-results/publish';
beforeEach(() => {
  mockTx = makeTx();
  mockSend.mockReset().mockResolvedValue({ MessageId: 'message' });
  process.env.COMMERCE_RESULT_QUEUE_URL = 'commerce-url';
  process.env.FULFILLMENT_RESULT_QUEUE_URL = 'fulfillment-url';
});
it('sends exactly the immutable body to the trusted destination using Standard queue parameters', async () => {
  await sendInventoryResult(row());
  await sendInventoryResult(row({ destination: 'fulfillment' }));
  const commands = mockSend.mock.calls.map(([command]) => (command as SendMessageCommand).input);
  expect(commands.map((command) => command.QueueUrl)).toEqual(['commerce-url', 'fulfillment-url']);
  for (const command of commands)
    expect(Object.keys(command).sort()).toEqual(['MessageBody', 'QueueUrl']);
  expect(JSON.parse(commands[0].MessageBody!)).toEqual(payload);
});
it('delivers the existing Fulfillment return and cancellation result shapes', async () => {
  const base = { ...payload, outcome: 'SUCCEEDED', resourceId: 'resource',
    operationId: 'operation', eventId: 'operation:result' };
  const resultPayloads = [
    { ...base, resourceType: 'return', result: { returnId: 'resource', sellerOrderId: 'order',
      evidenceHash: 'b'.repeat(64), lines: [{ commercePurchaseLineId: 'line', itemId: 1,
        movementId: 2, quantity: 1 }] } },
    { ...base, resourceType: 'cancellation', result: { cancellationId: 'resource', sellerOrderId: 'order',
      lines: [{ commercePurchaseLineId: 'line', itemId: 1, movementId: 2, quantity: 1 }] } },
  ];
  for (const result of resultPayloads)
    await sendInventoryResult(row({ destination: 'fulfillment', payload: result,
      payloadHash: workflowInputHash(result) }));
  expect(mockSend).toHaveBeenCalledTimes(2);
  await expect(sendInventoryResult(row({ destination: 'commerce', payload: resultPayloads[0],
    payloadHash: workflowInputHash(resultPayloads[0]) }))).rejects.toThrow('RESULT_INVALID');
});
it('delivers an exact replacement stock hold result only to Fulfillment', async () => {
  const replacement = { ...payload, outcome: 'SUCCEEDED', resourceType: 'replacement-shipment',
    resourceId: 'shipment', result: { shipmentId: 'shipment', entitlementId: 'entitlement',
      sellerOrderId: 'order', itemId: 1, heldMovementId: 2, quantity: 1 } };
  await sendInventoryResult(row({ destination: 'fulfillment', payload: replacement,
    payloadHash: workflowInputHash(replacement) }));
  expect(mockSend).toHaveBeenCalledTimes(1);
  await expect(sendInventoryResult(row({ destination: 'commerce', payload: replacement,
    payloadHash: workflowInputHash(replacement) }))).rejects.toThrow('RESULT_INVALID');
});
it('rejects corrupt persisted lineage or missing configuration before send', async () => {
  for (const changes of [
    { payloadHash: 'different' },
    { operationId: 'other' },
    { eventId: 'other' },
  ]) {
    await expect(sendInventoryResult(row(changes))).rejects.toThrow('RESULT_INVALID');
  }
  delete process.env.COMMERCE_RESULT_QUEUE_URL;
  await expect(sendInventoryResult(row())).rejects.toThrow('DELIVERY_CONFIGURATION');
  expect(mockSend).not.toHaveBeenCalled();
});
it('claims an available row and increments the lease fence', async () => {
  expect(await claimInventoryResult()).toBeNull();
  mockTx.$queryRaw.mockResolvedValue([{ id: 'delivery' }]);
  expect(await claimInventoryResult()).toEqual(row());
  expect(mockTx.inventoryResultOutbox.update).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        attempts: { increment: 1 },
        fencingToken: { increment: 1 },
        leaseOwner: expect.any(String),
      }),
    }),
  );
});
it('recovers an exhausted crashed lease without another send', async () => {
  mockTx.$queryRaw.mockResolvedValueOnce([{ id: 'delivery' }]).mockResolvedValue([]);
  mockTx.inventoryResultOutbox.findUniqueOrThrow.mockResolvedValue(row({ attempts: 8 }));
  expect(await handler()).toEqual({ delivered: 0 });
  expect(mockTx.inventoryCommandRecovery.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      create: expect.objectContaining({
        assignedOwner: 'inventory-operations',
        severity: 'HIGH',
        nextAction: 'REDELIVER_ORIGINAL_RESULT',
        dueAt: now,
      }),
    }),
  );
  expect(mockSend).not.toHaveBeenCalled();
});
it('settles accepted sends and bounds rejected-send delay and attempts', async () => {
  await settleInventoryResult(row(), true);
  expect(mockTx.inventoryResultOutbox.updateMany).toHaveBeenLastCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ state: 'DELIVERED', deliveredAt: now }),
    }),
  );
  await settleInventoryResult(row(), false);
  expect(mockTx.inventoryResultOutbox.updateMany).toHaveBeenLastCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        state: 'PENDING',
        nextAttemptAt: new Date(now.getTime() + 1000),
      }),
    }),
  );
  await settleInventoryResult(row({ attempts: 20 }), false);
  expect(mockTx.inventoryResultOutbox.updateMany).toHaveBeenLastCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        state: 'EXHAUSTED',
        nextAttemptAt: new Date(now.getTime() + 300000),
      }),
    }),
  );
  expect(mockTx.inventoryCommandRecovery.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      create: expect.objectContaining({
        assignedOwner: 'inventory-operations',
        severity: 'HIGH',
        nextAction: 'REDELIVER_ORIGINAL_RESULT',
        dueAt: now,
      }),
    }),
  );
  mockTx.inventoryResultOutbox.updateMany.mockResolvedValue({ count: 0 });
  await expect(settleInventoryResult(row(), true)).rejects.toThrow('STALE_DELIVERY');
});
it('does not convert an accepted send followed by acknowledgement failure into a rejected send', async () => {
  mockTx.$queryRaw.mockResolvedValue([{ id: 'delivery' }]);
  mockTx.inventoryResultOutbox.updateMany.mockRejectedValue(new Error('acknowledgement lost'));
  await expect(publishInventoryResults()).rejects.toThrow('acknowledgement lost');
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockTx.inventoryResultOutbox.updateMany).toHaveBeenCalledTimes(1);
  expect(mockTx.inventoryResultOutbox.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ state: 'DELIVERED' }) }),
  );
});
it('retries provider failures and limits successful batches', async () => {
  mockTx.$queryRaw.mockResolvedValueOnce([{ id: 'delivery' }]).mockResolvedValue([]);
  expect(
    await publishInventoryResults(async () => {
      throw new Error('provider unavailable');
    }),
  ).toEqual({ delivered: 0 });
  expect(mockTx.inventoryResultOutbox.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ state: 'PENDING' }) }),
  );
  mockTx.$queryRaw.mockResolvedValue([{ id: 'delivery' }]);
  expect(await publishInventoryResults()).toEqual({ delivered: 20 });
  expect(mockSend).toHaveBeenCalledTimes(20);
});

it('stops claiming when the invocation time budget is spent', async () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(25000);
  try {
    expect(await publishInventoryResults()).toEqual({ delivered: 0 });
    expect(mockTx.$queryRaw).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});

it('requires a nonempty SQS message identity before acknowledging delivery', async () => {
  for (const response of [{}, { MessageId: '' }, { MessageId: '  ' }, { MessageId: 1 }]) {
    mockSend.mockResolvedValue(response);
    await expect(sendInventoryResult(row())).rejects.toThrow('DELIVERY_UNAVAILABLE');
  }
  mockTx.$queryRaw.mockResolvedValueOnce([{ id: 'delivery' }]).mockResolvedValue([]);
  expect(await publishInventoryResults()).toEqual({ delivered: 0 });
  expect(mockTx.inventoryResultOutbox.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ state: 'PENDING' }) }),
  );
});
