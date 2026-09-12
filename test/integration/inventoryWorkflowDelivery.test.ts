require('../helpers/purchaseTestEnvironment.cjs');
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import prisma from '@/lib/prismaInventory';
import { consumeInventoryCommand, consumeInventoryCommandInTransaction } from '@/inventory/services/workflows/inventoryCommandService';
import { claimInventoryResult, settleInventoryResult, publishInventoryResults } from '@/inventory/services/workflows/inventoryResultPublisher';
import { databaseNow } from '@/inventory/services/stockReservationShared';
import { expireStockReservations } from '@/inventory/services/stockReservationExpiryService';
import { commandEnvelope, rehashCommand } from '../helpers/inventoryWorkflowFixtures';
import type { InventoryCommandEnvelope } from '@/inventory/types/inventoryWorkflowEnvelope';

describe('durable Inventory workflow transactions', () => {
  let itemId: number;
  let itemCode: string;
  let command: InventoryCommandEnvelope;
  beforeEach(async () => {
    itemCode = `workflow-${randomUUID()}`;
    itemId = (await prisma.item.create({ data: { itemCode, kind: 'STOCK', sellerIdentifier: 'seller' } })).id;
    await prisma.movement.create({ data: { itemId, direction: 'IN', reason: 'STOCKED', quantity: 2 } });
    command = commandEnvelope('INVENTORY_RESERVE', { checkoutId: itemCode, version: 1, lines: [{ lineId: 'line', accountId: 'seller', sourceInvId: itemCode, quantity: 2 }] });
  });
  afterEach(async () => {
    const ids = (await prisma.inventoryCommand.findMany({ where: { OR: [{ resourceId: itemCode }, { immutableEnvelope: { path: ['input', 'checkoutId'], equals: itemCode } }] }, select: { operationId: true } })).map(row => row.operationId);
    await prisma.inventoryResultOutbox.deleteMany({ where: { operationId: { in: ids } } });
    await prisma.inventoryInboxEvent.deleteMany({ where: { operationId: { in: ids } } });
    await prisma.inventoryCommandRecovery.deleteMany({ where: { operationId: { in: ids } } });
    await prisma.inventoryCommand.deleteMany({ where: { operationId: { in: ids } } });
    await prisma.stockReservation.deleteMany({ where: { itemId } });
    await prisma.reservationOperation.deleteMany({ where: { checkoutId: itemCode } });
    await prisma.movement.deleteMany({ where: { itemId } });
    await prisma.item.delete({ where: { id: itemId } });
  });
  afterAll(async () => prisma.$disconnect());
  const consume = (event = command) => consumeInventoryCommand(event, event.producer);
  it('atomically records one hold and result under concurrent exact replay', async () => {
    const [first, second] = await Promise.all([consume(), consume()]);
    expect(first).toEqual(second);
    expect(first.outcome).toBe('SUCCEEDED');
    expect(await prisma.inventoryInboxEvent.count({ where: { operationId: command.operationId } })).toBe(1);
    expect(await prisma.inventoryResultOutbox.count({ where: { operationId: command.operationId } })).toBe(1);
    expect(await prisma.movement.count({ where: { itemId, reason: 'RESERVED' } })).toBe(1);
    expect(await consume({ ...command, eventId: randomUUID() })).toEqual(first);
  });
  it('rejects changed deadline, hash, producer source and event identity without effects', async () => {
    await consume();
    await expect(consume(rehashCommand({ ...command, deadlineAt: new Date(Date.now() + 120000).toISOString() }))).rejects.toThrow('ENVELOPE_CONFLICT');
    await expect(consume({ ...command, operationInputHash: '0'.repeat(64) })).rejects.toThrow('HASH_MISMATCH');
    await expect(consumeInventoryCommand(command, 'fulfillment')).rejects.toThrow('SOURCE_MISMATCH');
    await expect(consume(rehashCommand({ ...command, operationId: randomUUID() }))).rejects.toThrow('INBOX_CONFLICT');
    expect(await prisma.inventoryCommand.count({ where: { resourceId: itemCode } })).toBe(1);
  });
  it('rolls back the inbox, ledger and result when the enclosing transaction fails', async () => {
    await expect(prisma.$transaction(async tx => {
      await consumeInventoryCommandInTransaction(tx, command, 'commerce');
      throw new Error('lost database transaction');
    })).rejects.toThrow('lost database transaction');
    expect(await prisma.inventoryCommand.count({ where: { operationId: command.operationId } })).toBe(0);
    expect(await prisma.inventoryInboxEvent.count({ where: { operationId: command.operationId } })).toBe(0);
    expect(await prisma.inventoryResultOutbox.count({ where: { operationId: command.operationId } })).toBe(0);
    expect(await prisma.stockReservation.count({ where: { itemId } })).toBe(0);
    expect((await consume()).outcome).toBe('SUCCEEDED');
  });
  it('persists a definitive domain rejection without partial stock mutation', async () => {
    if (command.command !== 'INVENTORY_RESERVE') throw new Error('fixture');
    command = rehashCommand({ ...command, input: { ...command.input, lines: [{ ...command.input.lines[0], quantity: 3 }] } });
    const result = await consume();
    expect(result).toMatchObject({ outcome: 'FAILED', result: { errorCode: 'INVENTORY_RESERVATION_REJECTED', recoveryRequired: false } });
    expect(await prisma.stockReservation.count({ where: { itemId } })).toBe(0);
    expect(await prisma.inventoryResultOutbox.count({ where: { operationId: command.operationId } })).toBe(1);
  });
  it('makes unseen late reserve fail and late protected commands durably unknown without releasing stock', async () => {
    const hold = await consume();
    if (hold.outcome !== 'SUCCEEDED') throw new Error('fixture');
    const lines = hold.result.lines.map(({ reservationId, lineId, revision }) => ({ reservationId, lineId, revision }));
    const protect = commandEnvelope('INVENTORY_PROTECT', { checkoutId: itemCode, version: 1, paymentScopeId: 'scope', fence: 1, lines });
    const protectedResult = await consume(protect);
    expect(protectedResult.outcome).toBe('SUCCEEDED');
    const late = rehashCommand({ ...protect, operationId: randomUUID(), eventId: randomUUID(), deadlineAt: '2000-01-01T00:00:00.000Z' });
    const unknown = await consume(late);
    expect(unknown).toMatchObject({ outcome: 'UNKNOWN', result: { recoveryRequired: true, recoveryId: expect.any(String) } });
    expect(await consume(late)).toEqual(unknown);
    const recovery = await prisma.inventoryCommandRecovery.findFirstOrThrow({ where: { operationId: late.operationId } });
    expect(recovery).toMatchObject({ assignedOwner: 'inventory-operations', severity: 'HIGH', nextAction: 'INSPECT_PAYMENT_AND_RESERVATION' });
    expect(recovery.dueAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(recovery.createdAt.getTime()).toBeGreaterThan(Date.now() - 60000);
    expect((await prisma.stockReservation.findFirstOrThrow({ where: { itemId } })).state).toBe('PAYMENT_LOCKED');
    const expiredReserve = rehashCommand({ ...command, operationId: randomUUID(), eventId: randomUUID(), deadlineAt: '2000-01-01T00:00:00.000Z' });
    expect(await consume(expiredReserve)).toMatchObject({ outcome: 'FAILED', result: { errorCode: 'INVENTORY_RESERVE_DEADLINE_EXPIRED' } });
  });
  it('claims once across workers, fences expired acknowledgements and retries the identical result after accepted-send acknowledgement loss', async () => {
    await consume();
    const claims = await Promise.all([claimInventoryResult(), claimInventoryResult()]);
    const claim = claims.find(value => value && !('exhausted' in value));
    if (!claim || 'exhausted' in claim) throw new Error('fixture');
    expect(claims.filter(Boolean)).toHaveLength(1);
    const acceptedEventId = claim.eventId; // SQS accepted; the DB acknowledgement was lost.
    await prisma.inventoryResultOutbox.update({ where: { id: claim.id }, data: { leaseExpiresAt: new Date('2000-01-01') } });
    const next = await claimInventoryResult();
    if (!next || 'exhausted' in next) throw new Error('fixture');
    expect(next.eventId).toBe(acceptedEventId);
    expect(next.payload).toEqual(claim.payload);
    await expect(settleInventoryResult(claim, true)).rejects.toThrow('STALE_DELIVERY');
    await settleInventoryResult(next, true);
    expect((await prisma.inventoryResultOutbox.findUniqueOrThrow({ where: { id: claim.id } })).state).toBe('DELIVERED');
  });
  it('bounds delivery retries and records recovery without modifying the original result', async () => {
    const result = await consume();
    await prisma.inventoryResultOutbox.updateMany({ where: { operationId: command.operationId }, data: { attempts: 7 } });
    expect(await publishInventoryResults(async () => { throw new Error('provider unavailable'); })).toEqual({ delivered: 0 });
    expect((await prisma.inventoryResultOutbox.findFirstOrThrow({ where: { operationId: command.operationId } })).state).toBe('EXHAUSTED');
    expect(await prisma.inventoryCommandRecovery.count({ where: { operationId: command.operationId } })).toBe(1);
    const recovery = await prisma.inventoryCommandRecovery.findFirstOrThrow({ where: { operationId: command.operationId } });
    expect(recovery).toMatchObject({ assignedOwner: 'inventory-operations', severity: 'HIGH', nextAction: 'REDELIVER_ORIGINAL_RESULT' });
    expect(recovery.dueAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(await consume()).toEqual(result);
  });
  it('redelivers an unchanged logical result for a fresh reconciliation receipt only', async () => {
    const original = await consume();
    expect(await publishInventoryResults(async () => {})).toEqual({ delivered: 1 });
    const reconciliation = { ...command, eventId: `${command.operationId}:reconcile:2` };
    expect(await consume(reconciliation)).toEqual(original);
    expect(await consume(reconciliation)).toEqual(original);
    const rows = await prisma.inventoryResultOutbox.findMany({ where: { operationId: command.operationId } });
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.eventId)).toEqual([original.eventId, original.eventId]);
    expect(rows.filter(row => row.state === 'PENDING')).toHaveLength(1);
    expect(await publishInventoryResults(async () => {})).toEqual({ delivered: 1 });
    expect(await prisma.movement.count({ where: { itemId, reason: 'RESERVED' } })).toBe(1);
  });
  it.each(['UTC', 'Europe/Berlin'])('uses absolute due and expiry instants under %s sessions', async zone => {
    await consume();
    await prisma.stockReservation.updateMany({ where: { itemId }, data: { expiresAt: new Date('2000-01-01') } });
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('TimeZone', ${zone}, true)`;
      const claim = await claimInventoryResult(tx);
      expect(claim).not.toBeNull();
      const now = await databaseNow(tx);
      expect(await tx.stockReservation.count({ where: { itemId, state: 'HELD', expiresAt: { lte: now } } })).toBe(1);
    });
    expect((await expireStockReservations()).lines.some(line => line.state === 'EXPIRED')).toBe(true);
  });

  it('commits an exact seller subset through trusted Fulfillment lineage while retaining the other protected line', async () => {
    if (command.command !== 'INVENTORY_RESERVE') throw new Error('fixture');
    command = rehashCommand({ ...command, input: { ...command.input, lines: [
      { ...command.input.lines[0], quantity: 1 }, { ...command.input.lines[0], lineId: 'second', quantity: 1 },
    ] } });
    const held = await consume();
    if (held.outcome !== 'SUCCEEDED') throw new Error('fixture');
    const lines = held.result.lines.map(({ reservationId, lineId, revision }) => ({ reservationId, lineId, revision }));
    const protectedResult = await consume(commandEnvelope('INVENTORY_PROTECT', { checkoutId: itemCode, version: 1, paymentScopeId: 'scope', fence: 1, lines }));
    if (protectedResult.outcome !== 'SUCCEEDED') throw new Error('fixture');
    const selected = protectedResult.result.lines[0];
    const commit = rehashCommand({ ...commandEnvelope('INVENTORY_COMMIT', {
      checkoutId: itemCode, version: 1, paymentScopeId: 'scope', fence: 1, paymentId: 'payment', purchaseId: 'purchase', commerceSellerOrderId: 'seller-order',
      lines: [{ reservationId: selected.reservationId, lineId: selected.lineId, revision: selected.revision }],
    }), resourceVersion: 8 });
    await expect(consumeInventoryCommand(commit, 'commerce')).rejects.toThrow('SOURCE_MISMATCH');
    const committed = await consumeInventoryCommand(commit, 'fulfillment');
    expect(committed).toMatchObject({ outcome: 'SUCCEEDED', resourceVersion: 8, result: { lines: [expect.objectContaining({ state: 'COMMITTED', revision: 2 })] } });
    expect(await consumeInventoryCommand(commit, 'fulfillment')).toEqual(committed);
    expect(await prisma.stockReservation.count({ where: { itemId, state: 'PAYMENT_LOCKED' } })).toBe(1);
    expect(await prisma.movement.count({ where: { itemId, reason: 'SOLD' } })).toBe(1);
  });

});
