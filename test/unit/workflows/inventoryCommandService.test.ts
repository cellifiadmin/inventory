import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import createError from 'http-errors';
import { commandEnvelope, rehashCommand } from '../../helpers/inventoryWorkflowFixtures';
import { reservationResponse } from '../../helpers/reservationFixtures';
import type { InventoryCommand, InventoryInboxEvent } from '.prisma/inventoryClient';
const asyncMock = <T>(value: T) => jest.fn<(...args: unknown[]) => Promise<T>>().mockResolvedValue(value);
const mockApply = asyncMock(reservationResponse());
jest.mock('@/inventory/services/stockReservationService', () => ({ reserveStock: (...args: unknown[]) => mockApply(...args) }));
jest.mock('@/inventory/services/reservationProtectionService', () => ({ protectReservations: (...args: unknown[]) => mockApply(...args) }));
jest.mock('@/inventory/services/stockCommitService', () => ({ commitStock: (...args: unknown[]) => mockApply(...args) }));
jest.mock('@/inventory/services/stockReleaseService', () => ({ releaseStock: (...args: unknown[]) => mockApply(...args) }));
const now = new Date('2030-01-01');
const makeTx = () => ({
  inventoryCommand: { findUnique: asyncMock<Pick<InventoryCommand, 'state' | 'envelopeHash' | 'result'> | null>(null),
    create: asyncMock({ state: 'RECEIVED' }), update: asyncMock({}) },
  inventoryInboxEvent: { createMany: asyncMock({ count: 1 }), findUniqueOrThrow: asyncMock<Partial<InventoryInboxEvent>>({}) },
  inventoryResultOutbox: { create: asyncMock({}) }, inventoryCommandRecovery: { create: asyncMock({ id: 'recovery' }) },
  reservationOperation: { findUnique: asyncMock<{} | null>(null) }, $executeRaw: asyncMock(0), $queryRaw: asyncMock([]),
});
let mockTx = makeTx();
jest.mock('@/inventory/services/stockReservationShared', () => ({ databaseNow: async () => now,
  withStockTransaction: (work: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => work(mockTx) }));
import { consumeInventoryCommand } from '@/inventory/services/workflows/inventoryCommandService';
import { workflowInputHash } from '@/inventory/services/workflows/workflowIdentity';
import { inventoryCommandEnvelopeSchema, inventoryResultEnvelopeSchema } from '@/inventory/types/inventoryWorkflowEnvelope';
const reserve = () => rehashCommand({ ...commandEnvelope('INVENTORY_RESERVE', { checkoutId: 'checkout', version: 1, expiresAt: '2030-01-01T00:15:00.000Z',
  lines: [{ lineId: 'line', accountId: 'seller', sourceInvId: 'item', quantity: 1 }] }), deadlineAt: '2031-01-01T00:00:00.000Z' });
let event = reserve();
const useReceipt = () => mockTx.inventoryInboxEvent.findUniqueOrThrow.mockResolvedValue({ operationId: event.operationId, payloadHash: workflowInputHash(event) });
beforeEach(() => { mockTx = makeTx(); event = reserve(); mockApply.mockReset().mockResolvedValue(reservationResponse()); useReceipt(); });

describe('Inventory command receipt and results', () => {
  it('binds whole-checkout immutable input and writes result atomically', async () => {
    expect(await consumeInventoryCommand(event, 'commerce')).toMatchObject({ outcome: 'SUCCEEDED', operationId: event.operationId, operationInputHash: event.operationInputHash });
    expect(mockApply).toHaveBeenCalledWith({ ...event.input, operationId: event.operationId }, mockTx);
    expect(mockTx.inventoryResultOutbox.create).toHaveBeenCalledTimes(1);
  });
  it('checks source and canonical scope hash before writing receipts', async () => {
    await expect(consumeInventoryCommand(event, 'fulfillment')).rejects.toThrow('SOURCE_MISMATCH');
    await expect(consumeInventoryCommand({ ...event, operationInputHash: '0'.repeat(64) }, 'commerce')).rejects.toThrow('HASH_MISMATCH');
    expect(mockTx.inventoryCommand.create).not.toHaveBeenCalled();
  });
  it('rejects changed immutable envelopes and conflicting event identities', async () => {
    mockTx.inventoryCommand.findUnique.mockResolvedValue({ state: 'RECEIVED', envelopeHash: 'different', result: null });
    await expect(consumeInventoryCommand(event, 'commerce')).rejects.toThrow('ENVELOPE_CONFLICT');
    mockTx.inventoryCommand.findUnique.mockResolvedValue(null);
    mockTx.inventoryInboxEvent.findUniqueOrThrow.mockResolvedValue({ operationId: 'other' });
    await expect(consumeInventoryCommand(event, 'commerce')).rejects.toThrow('INBOX_CONFLICT');
    mockTx.inventoryInboxEvent.findUniqueOrThrow.mockResolvedValue({ operationId: event.operationId, payloadHash: 'changed' });
    await expect(consumeInventoryCommand(event, 'commerce')).rejects.toThrow('INBOX_CONFLICT');
  });
  it('returns the exact stored terminal result without reapplying effects', async () => {
    const result = await consumeInventoryCommand(event, 'commerce');
    const { eventId, ...immutable } = event;
    mockTx.inventoryCommand.findUnique.mockResolvedValue({ state: 'SUCCEEDED', envelopeHash: workflowInputHash(immutable), result });
    mockApply.mockClear();
    mockTx.inventoryInboxEvent.createMany.mockResolvedValue({ count: 0 });
    expect(await consumeInventoryCommand(event, 'commerce')).toEqual(result);
    mockTx.inventoryInboxEvent.createMany.mockResolvedValue({ count: 1 });
    expect(await consumeInventoryCommand(event, 'commerce')).toEqual(result);
    expect(mockApply).not.toHaveBeenCalled();
  });
  it('uses a savepoint for definitive rejections and lets unknown infrastructure failures abort', async () => {
    mockApply.mockRejectedValue(createError(409, 'private details'));
    expect(await consumeInventoryCommand(event, 'commerce')).toMatchObject({ outcome: 'FAILED', result: { errorCode: 'INVENTORY_RESERVATION_REJECTED', recoveryRequired: false } });
    expect(mockTx.$executeRaw.mock.calls.map(([sql]) => String(sql))).toContain('ROLLBACK TO SAVEPOINT inventory_command_effects');
    for (const error of [new Error('lost connection'), createError(503)]) {
      mockApply.mockRejectedValue(error);
      await expect(consumeInventoryCommand(event, 'commerce')).rejects.toBe(error);
    }
  });
  it('rejects only fresh late reserve and replays a previously accepted domain command', async () => {
    event = rehashCommand({ ...event, deadlineAt: '2000-01-01T00:00:00.000Z' }); useReceipt();
    expect(await consumeInventoryCommand(event, 'commerce')).toMatchObject({ outcome: 'FAILED', result: { errorCode: 'INVENTORY_RESERVE_DEADLINE_EXPIRED' } });
    expect(mockApply).not.toHaveBeenCalled();
    mockTx.reservationOperation.findUnique.mockResolvedValue({});
    expect(await consumeInventoryCommand(event, 'commerce')).toMatchObject({ outcome: 'SUCCEEDED' });
  });
  it.each(['INVENTORY_PROTECT', 'INVENTORY_RELEASE', 'INVENTORY_COMMIT'] as const)('routes %s and records recovery for unseen expiry', async command => {
    const base = { checkoutId: 'checkout', version: 1, lines: [{ reservationId: 'reservation', lineId: 'line', revision: 0 }] };
    const input = command === 'INVENTORY_RELEASE' ? { ...base, cause: 'cancelled' as const }
      : command === 'INVENTORY_COMMIT' ? { ...base, paymentScopeId: 'scope', fence: 1, paymentId: 'payment', purchaseId: 'purchase', commerceSellerOrderId: 'order' }
      : { ...base, paymentScopeId: 'scope', fence: 1 };
    event = rehashCommand({ ...commandEnvelope(command, input), deadlineAt: '2031-01-01T00:00:00.000Z' }); useReceipt();
    expect((await consumeInventoryCommand(event, event.producer)).outcome).toBe('SUCCEEDED');
    event = rehashCommand({ ...event, deadlineAt: '2000-01-01T00:00:00.000Z' }); useReceipt(); mockApply.mockClear();
    expect(await consumeInventoryCommand(event, event.producer)).toMatchObject({ outcome: 'UNKNOWN', result: { recoveryRequired: true, recoveryId: 'recovery' } });
    expect(mockApply).not.toHaveBeenCalled();
    expect(mockTx.inventoryCommandRecovery.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ assignedOwner: 'inventory-operations', severity: 'HIGH', nextAction: 'INSPECT_PAYMENT_AND_RESERVATION', dueAt: now }) }));
  });
  it('rejects malformed authority and scope bindings', () => {
    for (const update of [{ producer: 'fulfillment' }, { resourceId: 'other' }, { resourceType: 'other' }, { resourceVersion: 2 }, { stepKey: 'wrong' }, { participantKey: 'inventory:' }, { participantKey: 'other' }, { participantKey: 'inventory:seller' }]) {
      expect(inventoryCommandEnvelopeSchema.safeParse({ ...event, ...update }).success).toBe(false);
    }
  });
});

it('keeps derived result identities within the owner 191-character event limit', () => {
  expect(inventoryCommandEnvelopeSchema.safeParse({ ...event, operationId: 'a'.repeat(160) }).success).toBe(true);
  expect(inventoryCommandEnvelopeSchema.safeParse({ ...event, operationId: 'a'.repeat(161) }).success).toBe(false);
  const result = { type: 'WORKFLOW_RESULT', producer: 'inventory', schemaVersion: 1, eventId: 'e'.repeat(191), operationId: 'a'.repeat(160), executionId: 'execution', correlationId: 'correlation', operationInputHash: 'a'.repeat(64), resourceType: 'checkout', resourceId: 'checkout', resourceVersion: 1, outcome: 'FAILED', result: { errorCode: 'REJECTED', recoveryRequired: false } };
  expect(inventoryResultEnvelopeSchema.safeParse(result).success).toBe(true);
  expect(inventoryResultEnvelopeSchema.safeParse({ ...result, eventId: 'e'.repeat(192) }).success).toBe(false);
});
