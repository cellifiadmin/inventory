require('../helpers/purchaseTestEnvironment.cjs');

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import prisma from '@/lib/prismaInventory';
import { protectReservations } from '@/inventory/services/reservationProtectionService';
import { commitStock } from '@/inventory/services/stockCommitService';
import { releaseStock } from '@/inventory/services/stockReleaseService';
import { expireStockReservations } from '@/inventory/services/stockReservationExpiryService';
import { createStockMovement } from '@/services/stockService';
import { reserveStock } from '@/inventory/services/stockReservationService';

describe('typed reservation lifecycle against PostgreSQL', () => {
  let itemId: number;
  let itemCode: string;
  const seller = 'protection-test-seller';
  beforeEach(async () => {
    itemCode = `protection-test-${randomUUID()}`;
    const item = await prisma.item.create({ data: { kind: 'STOCK', itemCode, sellerIdentifier: seller } });
    itemId = item.id;
    await prisma.movement.create({ data: { itemId, direction: 'IN', reason: 'STOCKED', quantity: 2 } });
  });
  afterEach(async () => {
    await prisma.stockReservation.deleteMany({ where: { itemId } });
    await prisma.reservationOperation.deleteMany({ where: { checkoutId: itemCode } });
    await prisma.movement.deleteMany({ where: { itemId } });
    await prisma.item.delete({ where: { id: itemId } });
  });
  afterAll(async () => prisma.$disconnect());

  it('returns typed reservation identity and an optimistic revision', async () => {
    const reservation = await reserveStock({ operationId: randomUUID(), checkoutId: itemCode, version: 2,
      lines: [{ lineId: 'line', accountId: seller, sourceInvId: itemCode, quantity: 1 }] });
    expect(reservation.lines[0]).toEqual(expect.objectContaining({
      reservationId: expect.any(String), revision: 0, state: 'HELD',
    }));
  });

  const reserve = () => reserveStock({ operationId: randomUUID(), checkoutId: itemCode, version: 2,
    lines: [{ lineId: 'line', accountId: seller, sourceInvId: itemCode, quantity: 2 }] });
  const protect = async () => {
    const hold = await reserve();
    return protectReservations({ operationId: randomUUID(), checkoutId: itemCode, version: 2,
      paymentScopeId: 'payment-scope', fence: 1, lines: hold.lines.map(({ reservationId, lineId, revision }) => ({ reservationId, lineId, revision })) });
  };
  const lineage = (result: Awaited<ReturnType<typeof reserve>>) => result.lines.map(({ reservationId, lineId, revision }) => ({ reservationId, lineId, revision }));
  const commit = (result: Awaited<ReturnType<typeof reserve>>, operationId = randomUUID()) => ({
    operationId, checkoutId: itemCode, version: 2, paymentScopeId: 'payment-scope', fence: 1,
    paymentId: 'payment', purchaseId: 'purchase', commerceSellerOrderId: 'seller-order', lines: lineage(result),
  });
  const release = (result: Awaited<ReturnType<typeof reserve>>) => ({ operationId: randomUUID(), checkoutId: itemCode, version: 2,
    cause: 'payment_failed' as const, lines: lineage(result), financialResolution: {
      resolutionId: 'resolution', paymentScopeId: 'payment-scope', fence: 2,
      scopeClosedAt: new Date('2020-01-01').toISOString(), outcome: 'FAILED' as const,
    } });
  const balance = async () => (await prisma.movement.findMany({ where: { itemId } }))
    .reduce((sum, movement) => sum + (movement.direction === 'IN' ? movement.quantity : -movement.quantity), 0);

  it('preserves protected stock after expiry and commits exactly once after a lost response', async () => {
    const protectedHold = await protect();
    await prisma.stockReservation.update({ where: { id: protectedHold.lines[0].reservationId }, data: { expiresAt: new Date('2000-01-01') } });
    expect((await expireStockReservations()).lines.find(line => line.reservationId === protectedHold.lines[0].reservationId)).toBeUndefined();
    expect(await balance()).toBe(0);
    const command = commit(protectedHold);
    const first = await commitStock(command);
    expect(await commitStock(command)).toEqual(first);
    expect(first.lines[0].state).toBe('COMMITTED');
    expect(await prisma.movement.count({ where: { itemId, reason: 'SOLD' } })).toBe(1);
    expect(await balance()).toBe(0);
    expect((await prisma.stockReservation.findUniqueOrThrow({ where: { id: first.lines[0].reservationId } })).commerceSellerOrderId).toBe('seller-order');
  });
  it('makes concurrent commit and verified release mutually exclusive', async () => {
    const protectedHold = await protect();
    const results = await Promise.allSettled([commitStock(commit(protectedHold)), releaseStock(release(protectedHold))]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const row = await prisma.stockReservation.findUniqueOrThrow({ where: { id: protectedHold.lines[0].reservationId } });
    expect(await prisma.movement.count({ where: { itemId, reason: 'RELEASED' } })).toBe(1);
    expect(await balance()).toBe(row.state === 'COMMITTED' ? 0 : 2);
  });
  it('rejects release without verified closure, mismatched scope, or a newer fence', async () => {
    const protectedHold = await protect();
    const command = release(protectedHold);
    await expect(releaseStock({ ...command, financialResolution: undefined })).rejects.toThrow('Verified closed payment scope required');
    await expect(releaseStock({ ...command, financialResolution: { ...command.financialResolution, fence: 1 } })).rejects.toThrow('Verified closed payment scope required');
    await expect(releaseStock({ ...command, financialResolution: { ...command.financialResolution, paymentScopeId: 'other' } })).rejects.toThrow('Verified closed payment scope required');
    expect(await balance()).toBe(0);
  });
  it('rejects late capture commitment after a verified safe release without inventing sold stock', async () => {
    const protectedHold = await protect();
    const released = await releaseStock(release(protectedHold));
    await expect(commitStock(commit(protectedHold))).rejects.toThrow('Reservation revision stale');
    await expect(commitStock(commit(released))).rejects.toThrow('Reservation payment protection mismatch');
    expect(await balance()).toBe(2);
    expect(await prisma.movement.count({ where: { itemId, reason: 'SOLD' } })).toBe(0);
  });
  it('expires an ordinary hold once and fences a later payment protection command', async () => {
    const hold = await reserve();
    await prisma.stockReservation.update({ where: { id: hold.lines[0].reservationId }, data: { expiresAt: new Date('2000-01-01') } });
    await Promise.all([expireStockReservations(), expireStockReservations()]);
    expect(await balance()).toBe(2);
    expect(await prisma.movement.count({ where: { itemId, reason: 'RELEASED' } })).toBe(1);
    await expect(protectReservations({ operationId: randomUUID(), checkoutId: itemCode, version: 2,
      paymentScopeId: 'scope', fence: 1, lines: lineage(hold) })).rejects.toThrow('Reservation revision stale');
  });
  it('serializes ordinary stock writes against checkout reservation acceptance', async () => {
    const results = await Promise.allSettled([reserve(), createStockMovement({ itemId, quantity: 2, direction: 'OUT', reason: 'SOLD' })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await balance()).toBe(0);
  });
  it('rolls back reservation and command result with an enclosing inbox transaction failure', async () => {
    await expect(prisma.$transaction(async tx => {
      await reserveStock({ operationId: 'rollback-operation', checkoutId: itemCode, version: 2,
        lines: [{ lineId: 'line', accountId: seller, sourceInvId: itemCode, quantity: 2 }] }, tx);
      throw new Error('outbox persistence failed');
    })).rejects.toThrow('outbox persistence failed');
    expect(await balance()).toBe(2);
    expect(await prisma.reservationOperation.findUnique({ where: { id: 'rollback-operation' } })).toBeNull();
  });
  it('commits independent seller subsets from one protected checkout without overlapping movements', async () => {
    const other = await prisma.item.create({ data: { kind: 'STOCK', itemCode: `${itemCode}-other`, sellerIdentifier: 'other-seller' } });
    try {
      await prisma.movement.create({ data: { itemId: other.id, quantity: 1, direction: 'IN', reason: 'STOCKED' } });
      const held = await reserveStock({ operationId: randomUUID(), checkoutId: itemCode, version: 2, lines: [
        { lineId: 'line', accountId: seller, sourceInvId: itemCode, quantity: 2 },
        { lineId: 'other-line', accountId: 'other-seller', sourceInvId: `${itemCode}-other`, quantity: 1 },
      ] });
      const protectionCommand = { operationId: randomUUID(), checkoutId: itemCode, version: 2,
        paymentScopeId: 'payment-scope', fence: 1, lines: lineage(held) };
      const protectedHolds = await protectReservations(protectionCommand);
      expect(await protectReservations(protectionCommand)).toEqual(protectedHolds);
      const commands = protectedHolds.lines.map((line, index) => ({ ...commit(protectedHolds),
        commerceSellerOrderId: `seller-order-${index}`, lines: [{ reservationId: line.reservationId, lineId: line.lineId, revision: line.revision }] }));
      const committed = await Promise.all(commands.map(command => commitStock(command)));
      expect(committed.every(result => result.lines[0].state === 'COMMITTED')).toBe(true);
      expect(await prisma.movement.count({ where: { itemId: { in: [itemId, other.id] }, reason: 'SOLD' } })).toBe(2);
      expect(await balance()).toBe(0);
    } finally {
      await prisma.stockReservation.deleteMany({ where: { itemId: other.id } });
      await prisma.movement.deleteMany({ where: { itemId: other.id } });
      await prisma.item.delete({ where: { id: other.id } });
    }
  });
  it('enforces unique checkout line and held movement lineage in PostgreSQL', async () => {
    const held = await reserve();
    const record = await prisma.stockReservation.findUniqueOrThrow({ where: { id: held.lines[0].reservationId } });
    const separateMovement = await prisma.movement.create({ data: { itemId, quantity: 1, direction: 'IN', reason: 'ADJUSTMENT' } });
    await expect(prisma.stockReservation.create({ data: {
      checkoutId: itemCode, checkoutVersion: 2, lineId: 'line', itemId,
      heldMovementId: separateMovement.id, expiresAt: record.expiresAt,
    } })).rejects.toMatchObject({ code: 'P2002' });
    await expect(prisma.stockReservation.create({ data: {
      checkoutId: itemCode, checkoutVersion: 3, lineId: 'different', itemId,
      heldMovementId: record.heldMovementId, expiresAt: record.expiresAt,
    } })).rejects.toMatchObject({ code: 'P2002' });
  });

  it.each(['heldMovementId', 'releasedMovementId', 'soldMovementId'] as const)('rejects a missing %s at the database boundary', async field => {
    const hold = await reserve();
    await expect(prisma.stockReservation.update({ where: { id: hold.lines[0].reservationId }, data: { [field]: -1 } }))
      .rejects.toMatchObject({ code: 'P2003' });
  });
  it('rejects a movement link from another inventory item at the database boundary', async () => {
    const hold = await reserve();
    const other = await prisma.item.create({ data: { kind: 'STOCK', itemCode: `${itemCode}-foreign`, sellerIdentifier: seller } });
    try {
      const movement = await prisma.movement.create({ data: { itemId: other.id, quantity: 1, direction: 'IN', reason: 'RELEASED' } });
      await expect(prisma.stockReservation.update({ where: { id: hold.lines[0].reservationId }, data: { releasedMovementId: movement.id } }))
        .rejects.toMatchObject({ code: 'P2003' });
    } finally {
      await prisma.movement.deleteMany({ where: { itemId: other.id } });
      await prisma.item.delete({ where: { id: other.id } });
    }
  });
  it('rejects a command that names another checkout operation lineage', async () => {
    const protectedHold = await protect();
    await expect(commitStock({ ...commit(protectedHold), checkoutId: 'other-checkout' })).rejects.toThrow('Reservation lineage invalid');
    expect(await balance()).toBe(0);
    expect(await prisma.movement.count({ where: { itemId, reason: 'SOLD' } })).toBe(0);
  });

});
