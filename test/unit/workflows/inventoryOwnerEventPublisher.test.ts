import { beforeEach, expect, it, jest } from '@jest/globals';
import type { InventoryOwnerEventDelivery } from '@/inventory/services/workflows/inventoryOwnerEventPublisher';
import { reservationOwnerEventFixture } from '../../helpers/reservationOwnerEventFixture';
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
const payload = reservationOwnerEventFixture();
const row = (updates: Partial<InventoryOwnerEventDelivery> = {}): InventoryOwnerEventDelivery => ({
  id: 'delivery',
  eventId: payload.eventId,
  event: {
    id: payload.eventId,
    scopeId: 'scope',
    scopeRevision: 2,
    checkoutId: 'checkout',
    checkoutVersion: 1,
    kind: 'INVENTORY_RESERVATION_EXPIRED',
    observedAt: new Date(payload.observedAt),
    payload,
    payloadHash: workflowInputHash(payload),
    createdAt: now,
  },
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
  inventoryOwnerEventOutbox: {
    findUniqueOrThrow: asyncMock(row()),
    update: asyncMock(row()),
    updateMany: asyncMock({ count: 1 }),
  },
  inventoryOwnerEventRecovery: { upsert: asyncMock({}) },
});
let mockTx = makeTx();
jest.mock('@/inventory/services/stockReservationShared', () => ({
  databaseNow: async () => now,
  withStockTransaction: (work: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => work(mockTx),
}));
import {
  claimInventoryOwnerEvent,
  settleInventoryOwnerEvent,
  sendInventoryOwnerEvent,
  publishInventoryOwnerEvents,
} from '@/inventory/services/workflows/inventoryOwnerEventPublisher';
import { handler } from '@/handlers/scheduled/reservation-owner-events/publish';
beforeEach(() => {
  mockTx = makeTx();
  mockSend.mockReset().mockResolvedValue({ MessageId: 'message' });
  process.env.COMMERCE_RESULT_QUEUE_URL = 'http://localhost:4566/000000000000/commerce-result';
  process.env.FULFILLMENT_RESULT_QUEUE_URL = 'fulfillment-url';
});
it('sends exactly the immutable body to the trusted destination using Standard queue parameters', async () => {
  await sendInventoryOwnerEvent(row());
  const commands = mockSend.mock.calls.map(([command]) => (command as SendMessageCommand).input);
  expect(commands.map((command) => command.QueueUrl)).toEqual([
    'http://localhost:4566/000000000000/commerce-result',
  ]);
  for (const command of commands)
    expect(Object.keys(command).sort()).toEqual(['MessageBody', 'QueueUrl']);
  expect(JSON.parse(commands[0].MessageBody!)).toEqual(payload);
});
it('rejects corrupt persisted lineage or missing configuration before send', async () => {
  for (const changes of [
    { payloadHash: 'different' },
    { id: 'other' },
    { scopeId: 'other' },
    { scopeRevision: 3 },
    { checkoutId: 'other' },
    { checkoutVersion: 2 },
    { kind: 'OTHER' },
    { observedAt: new Date('2029-01-01') },
  ]) {
    await expect(
      sendInventoryOwnerEvent(row({ event: { ...row().event, ...changes } as any })),
    ).rejects.toThrow('OWNER_EVENT_INVALID');
  }
  await expect(sendInventoryOwnerEvent(row({ eventId: 'other' }))).rejects.toThrow(
    'OWNER_EVENT_INVALID',
  );
  delete process.env.COMMERCE_RESULT_QUEUE_URL;
  await expect(sendInventoryOwnerEvent(row())).rejects.toThrow('DELIVERY_CONFIGURATION');
  expect(mockSend).not.toHaveBeenCalled();
});
it('claims an available row and increments the lease fence', async () => {
  expect(await claimInventoryOwnerEvent()).toBeNull();
  mockTx.$queryRaw.mockResolvedValue([{ id: 'delivery' }]);
  expect(await claimInventoryOwnerEvent()).toEqual(row());
  expect(mockTx.inventoryOwnerEventOutbox.update).toHaveBeenCalledWith(
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
  mockTx.inventoryOwnerEventOutbox.findUniqueOrThrow.mockResolvedValue(row({ attempts: 8 }));
  expect(await handler()).toEqual({ delivered: 0 });
  expect(mockTx.inventoryOwnerEventRecovery.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      create: expect.objectContaining({
        assignedOwner: 'inventory-operations',
        severity: 'HIGH',
        nextAction: 'REDELIVER_OWNER_EVENT',
        dueAt: now,
      }),
    }),
  );
  expect(mockSend).not.toHaveBeenCalled();
});
it('settles accepted sends and bounds rejected-send delay and attempts', async () => {
  await settleInventoryOwnerEvent(row(), true);
  expect(mockTx.inventoryOwnerEventOutbox.updateMany).toHaveBeenLastCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ state: 'DELIVERED', deliveredAt: now }),
    }),
  );
  await settleInventoryOwnerEvent(row(), false);
  expect(mockTx.inventoryOwnerEventOutbox.updateMany).toHaveBeenLastCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        state: 'PENDING',
        nextAttemptAt: new Date(now.getTime() + 1000),
      }),
    }),
  );
  await settleInventoryOwnerEvent(row({ attempts: 20 }), false);
  expect(mockTx.inventoryOwnerEventOutbox.updateMany).toHaveBeenLastCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        state: 'EXHAUSTED',
        nextAttemptAt: new Date(now.getTime() + 300000),
      }),
    }),
  );
  expect(mockTx.inventoryOwnerEventRecovery.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      create: expect.objectContaining({
        assignedOwner: 'inventory-operations',
        severity: 'HIGH',
        nextAction: 'REDELIVER_OWNER_EVENT',
        dueAt: now,
      }),
    }),
  );
  mockTx.inventoryOwnerEventOutbox.updateMany.mockResolvedValue({ count: 0 });
  await expect(settleInventoryOwnerEvent(row(), true)).rejects.toThrow('STALE_DELIVERY');
});
it('does not convert an accepted send followed by acknowledgement failure into a rejected send', async () => {
  mockTx.$queryRaw.mockResolvedValue([{ id: 'delivery' }]);
  mockTx.inventoryOwnerEventOutbox.updateMany.mockRejectedValue(new Error('acknowledgement lost'));
  await expect(publishInventoryOwnerEvents()).rejects.toThrow('acknowledgement lost');
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockTx.inventoryOwnerEventOutbox.updateMany).toHaveBeenCalledTimes(1);
  expect(mockTx.inventoryOwnerEventOutbox.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ state: 'DELIVERED' }) }),
  );
});
it('retries provider failures and limits successful batches', async () => {
  mockTx.$queryRaw.mockResolvedValueOnce([{ id: 'delivery' }]).mockResolvedValue([]);
  expect(
    await publishInventoryOwnerEvents(async () => {
      throw new Error('provider unavailable');
    }),
  ).toEqual({ delivered: 0 });
  expect(mockTx.inventoryOwnerEventOutbox.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ state: 'PENDING' }) }),
  );
  mockTx.$queryRaw.mockResolvedValue([{ id: 'delivery' }]);
  expect(await publishInventoryOwnerEvents()).toEqual({ delivered: 20 });
  expect(mockSend).toHaveBeenCalledTimes(20);
});

it('stops claiming when the invocation time budget is spent', async () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(25000);
  try {
    expect(await publishInventoryOwnerEvents()).toEqual({ delivered: 0 });
    expect(mockTx.$queryRaw).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});

it('requires a nonempty SQS message identity before acknowledging delivery', async () => {
  for (const response of [{}, { MessageId: '' }, { MessageId: '  ' }, { MessageId: 1 }]) {
    mockSend.mockResolvedValue(response);
    await expect(sendInventoryOwnerEvent(row())).rejects.toThrow('DELIVERY_UNAVAILABLE');
  }
  mockTx.$queryRaw.mockResolvedValueOnce([{ id: 'delivery' }]).mockResolvedValue([]);
  expect(await publishInventoryOwnerEvents()).toEqual({ delivered: 0 });
  expect(mockTx.inventoryOwnerEventOutbox.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ state: 'PENDING' }) }),
  );
});

it.each([
  'http://localhost:4566/000000000000/queue.fifo',
  'not-a-url',
  'file:///000000000000/queue',
])('rejects non-Standard or malformed owner destination %s', async (url) => {
  process.env.COMMERCE_RESULT_QUEUE_URL = url;
  await expect(sendInventoryOwnerEvent(row())).rejects.toThrow('DELIVERY_CONFIGURATION');
  expect(mockSend).not.toHaveBeenCalled();
});
