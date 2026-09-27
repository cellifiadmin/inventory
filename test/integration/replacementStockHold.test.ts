require('../helpers/purchaseTestEnvironment.cjs');
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, expect, it } from '@jest/globals';
import prisma from '@/lib/prismaInventory';
import { reserveStock, cleanupReservationScopeFixture } from '../helpers/reserveThroughOwner';
import { protectReservations } from '@/inventory/services/reservationProtectionService';
import { commitStock } from '@/inventory/services/stockCommitService';
import { applyReturnRestock } from '@/inventory/services/returnRestockService';
import { consumeReplacementStockCommand } from '@/inventory/services/workflows/replacementStockCommandService';
import { workflowInputHash } from '@/inventory/services/workflows/workflowIdentity';
import { stockBalance } from '@/inventory/services/stockReservationShared';

const itemIds: number[] = [];
const checkoutIds: string[] = [];
const returnIds: string[] = [];
const holdIds: string[] = [];
afterEach(async () => {
  const holdClient = (prisma as unknown as { replacementStockHold?: typeof prisma.replacementStockHold }).replacementStockHold;
  const holds = holdClient ? await holdClient.findMany({ where: { operationId: { in: holdIds } } }) : [];
  if (holdClient) await holdClient.deleteMany({ where: { operationId: { in: holdIds } } });
  await prisma.movement.deleteMany({ where: { id: { in: holds.flatMap(row => [row.heldMovementId,
    row.releasedMovementId, row.soldMovementId].filter((value): value is number => value !== null)) } } });
  await prisma.inventoryResultOutbox.deleteMany({ where: { operationId: { in: holdIds } } });
  await prisma.inventoryInboxEvent.deleteMany({ where: { operationId: { in: holdIds } } });
  await prisma.inventoryCommand.deleteMany({ where: { operationId: { in: holdIds } } });
  const restocks = await prisma.returnRestockLine.findMany({ where: { operationId: { in: returnIds } } });
  await prisma.returnRestockLine.deleteMany({ where: { operationId: { in: returnIds } } });
  await prisma.returnRestockOperation.deleteMany({ where: { operationId: { in: returnIds } } });
  await prisma.movement.deleteMany({ where: { id: { in: restocks.map(row => row.movementId) } } });
  for (const checkout of checkoutIds) await cleanupReservationScopeFixture(checkout);
  await prisma.movement.deleteMany({ where: { itemId: { in: itemIds } } });
  await prisma.item.deleteMany({ where: { id: { in: itemIds } } });
  itemIds.length = 0; checkoutIds.length = 0; returnIds.length = 0; holdIds.length = 0;
});
afterAll(() => prisma.$disconnect());

it('reserves exact original-sale stock once and rejects a competing replacement', async () => {
  const suffix = randomUUID();
  const item = await prisma.item.create({ data: { kind: 'STOCK', itemCode: `phone-${suffix}`,
    sellerIdentifier: `seller-${suffix}` } });
  itemIds.push(item.id); checkoutIds.push(item.itemCode);
  await prisma.movement.create({ data: { itemId: item.id, direction: 'IN', reason: 'STOCKED', quantity: 1 } });
  const lineId = `line-${suffix}`;
  const held = await reserveStock({ operationId: randomUUID(), checkoutId: item.itemCode, version: 1,
    expiresAt: new Date(Date.now() + 60000).toISOString(), lines: [{ lineId, accountId: item.sellerIdentifier,
      sourceInvId: item.itemCode, quantity: 1 }] });
  const lineage = (rows: typeof held.lines) => rows.map(({ reservationId, lineId, revision }) => ({ reservationId, lineId, revision }));
  const protectedStock = await protectReservations({ operationId: randomUUID(), checkoutId: item.itemCode,
    version: 1, paymentScopeId: `payment-${suffix}`, fence: 1, lines: lineage(held.lines) });
  const purchaseId = `purchase-${suffix}`, commerceSellerOrderId = `commercial-${suffix}`;
  await commitStock({ scope: protectedStock.scope, operationId: randomUUID(), checkoutId: item.itemCode,
    version: 1, paymentScopeId: `payment-${suffix}`, fence: 1, paymentId: `payment-${suffix}`,
    purchaseId, commerceSellerOrderId, lines: lineage(protectedStock.lines) });
  const restockOperationId = `return:${suffix}:restock:v1`;
  returnIds.push(restockOperationId);
  await applyReturnRestock({ operationId: restockOperationId, returnId: `return-${suffix}`,
    sellerOrderId: `order-${suffix}`, sellerAccountId: item.sellerIdentifier,
    purchaseId, commerceSellerOrderId, identifiers: [], evidenceHash: 'a'.repeat(64),
    lines: [{ sourceInvId: item.itemCode, commercePurchaseLineId: lineId, quantity: 1 }] });
  const input = { operationId: `replacement:shipment-${suffix}:reserve:v1`, shipmentId: `shipment-${suffix}`,
    entitlementId: `entitlement-${suffix}`, sellerOrderId: `order-${suffix}`,
    sellerAccountId: item.sellerIdentifier, purchaseId, commerceSellerOrderId,
    commercePurchaseLineId: lineId, sourceInvId: item.itemCode, quantity: 1 };
  holdIds.push(input.operationId);
  const { operationId, ...commandInput } = input;
  const descriptor = { kind: 'REPLACEMENT_STOCK', resourceType: 'replacement-shipment',
    resourceId: input.shipmentId, resourceVersion: 1, stepKey: 'INVENTORY_RESERVE_REPLACEMENT',
    participantKey: `inventory:${input.sellerAccountId}`, input: commandInput,
    deadlineAt: new Date(Date.now() + 60000).toISOString() };
  const command = { type: 'WORKFLOW_COMMAND', schemaVersion: 1, producer: 'fulfillment',
    command: descriptor.stepKey, eventId: `${operationId}:command`, operationId,
    executionId: `replacement:${input.shipmentId}`, correlationId: input.sellerOrderId,
    operationInputHash: workflowInputHash(descriptor), workflowKind: descriptor.kind,
    stepKey: descriptor.stepKey, participantKey: descriptor.participantKey,
    resourceType: descriptor.resourceType, resourceId: descriptor.resourceId, resourceVersion: 1,
    actorIdentifier: 'fixture-seller', deadlineAt: descriptor.deadlineAt, input: commandInput };
  const results = await Promise.all([consumeReplacementStockCommand(command, 'fulfillment'),
    consumeReplacementStockCommand(command, 'fulfillment')]);
  expect(results[0]).toEqual(results[1]);
  expect(results[0]).toMatchObject({ outcome: 'SUCCEEDED', result: {
    shipmentId: input.shipmentId, itemId: item.id, quantity: 1 } });
  expect(await stockBalance(prisma, item.id)).toBe(0);
  expect(await prisma.movement.count({ where: { itemId: item.id, reason: 'RESERVED',
    metadata: { path: ['replacementShipmentId'], equals: input.shipmentId } } })).toBe(1);
  expect(() => consumeReplacementStockCommand(command, 'commerce'))
    .toThrow('INVENTORY_COMMAND_SOURCE_MISMATCH');
  expect(await prisma.replacementStockHold.count({ where: { operationId } })).toBe(1);
  await expect(prisma.replacementStockHold.update({ where: { operationId },
    data: { state: 'COMMITTED' } })).rejects.toThrow();
  const another = (shipmentId: string, purchaseId = input.purchaseId) => {
    const nextInput = { ...commandInput, shipmentId, purchaseId };
    const nextId = `replacement:${shipmentId}:reserve:v1`;
    const nextDescriptor = { ...descriptor, resourceId: shipmentId, input: nextInput };
    holdIds.push(nextId);
    return { ...command, operationId: nextId, eventId: `${nextId}:command`,
      executionId: `replacement:${shipmentId}`, resourceId: shipmentId,
      operationInputHash: workflowInputHash(nextDescriptor), input: nextInput };
  };
  const unavailable = another(`other-${suffix}`);
  const failure = await consumeReplacementStockCommand(unavailable, 'fulfillment');
  expect(failure).toMatchObject({ outcome: 'FAILED', result: {
    errorCode: 'REPLACEMENT_STOCK_UNAVAILABLE', recoveryRequired: false, noEffect: null } });
  expect(await consumeReplacementStockCommand(unavailable, 'fulfillment')).toEqual(failure);
  const foreignPurchase = another(`foreign-${suffix}`, 'other-purchase');
  expect(await consumeReplacementStockCommand(foreignPurchase, 'fulfillment'))
    .toMatchObject({ outcome: 'FAILED', result: { errorCode: 'REPLACEMENT_STOCK_SALE_NOT_FOUND' } });
  expect(await prisma.replacementStockHold.count({ where: { operationId: { in: holdIds } } })).toBe(1);
  const phaseCommand = (phase: 'RELEASE' | 'COMMIT', reserve: typeof command, reserveResult: typeof results[0]) => {
    if (reserveResult.outcome !== 'SUCCEEDED') throw new Error('Expected held replacement');
    const transitionInput = { ...reserve.input, holdOperationId: reserve.operationId,
      itemId: reserveResult.result.itemId, heldMovementId: reserveResult.result.heldMovementId };
    const nextId = `replacement:${reserve.resourceId}:${phase.toLowerCase()}:v1`;
    const stepKey = `INVENTORY_${phase}_REPLACEMENT`;
    const nextDescriptor = { ...descriptor, resourceId: reserve.resourceId, stepKey,
      input: transitionInput };
    holdIds.push(nextId);
    return { ...reserve, operationId: nextId, command: stepKey, stepKey,
      eventId: `${nextId}:command`, operationInputHash: workflowInputHash(nextDescriptor),
      input: transitionInput };
  };
  const release = phaseCommand('RELEASE', command, results[0]);
  const released = await consumeReplacementStockCommand(release, 'fulfillment');
  expect(released).toMatchObject({ outcome: 'SUCCEEDED', result: {
    shipmentId: command.resourceId, phase: 'RELEASE', itemId: item.id, soldMovementId: null } });
  expect(await consumeReplacementStockCommand(release, 'fulfillment')).toEqual(released);
  expect(await stockBalance(prisma, item.id)).toBe(1);
  const nextReserve = another(`committed-${suffix}`);
  const nextHeld = await consumeReplacementStockCommand(nextReserve, 'fulfillment');
  expect(nextHeld.outcome).toBe('SUCCEEDED');
  const commit = phaseCommand('COMMIT', nextReserve, nextHeld);
  const committed = await consumeReplacementStockCommand(commit, 'fulfillment');
  expect(committed).toMatchObject({ outcome: 'SUCCEEDED', result: {
    shipmentId: nextReserve.resourceId, phase: 'COMMIT', itemId: item.id,
    soldMovementId: expect.any(Number) } });
  expect(await consumeReplacementStockCommand(commit, 'fulfillment')).toEqual(committed);
  expect(await stockBalance(prisma, item.id)).toBe(0);
  expect(await prisma.replacementStockHold.findUniqueOrThrow({ where: { shipmentId: nextReserve.resourceId } }))
    .toMatchObject({ state: 'COMMITTED', soldMovementId: expect.any(Number) });
  await prisma.movement.create({ data: { itemId: item.id, direction: 'IN', reason: 'STOCKED', quantity: 1 } });
  const raceReserve = another(`race-${suffix}`);
  const raceHeld = await consumeReplacementStockCommand(raceReserve, 'fulfillment');
  expect(raceHeld.outcome).toBe('SUCCEEDED');
  const [commitRace, releaseRace] = await Promise.all([
    consumeReplacementStockCommand(phaseCommand('COMMIT', raceReserve, raceHeld), 'fulfillment'),
    consumeReplacementStockCommand(phaseCommand('RELEASE', raceReserve, raceHeld), 'fulfillment'),
  ]);
  const outcomes = [commitRace, releaseRace];
  expect(outcomes.filter(row => row.outcome === 'SUCCEEDED')).toHaveLength(1);
  expect(outcomes.filter(row => row.outcome === 'FAILED')).toEqual([
    expect.objectContaining({ result: expect.objectContaining({ errorCode: 'REPLACEMENT_STOCK_ALREADY_RESOLVED' }) }),
  ]);
  const resolved = await prisma.replacementStockHold.findUniqueOrThrow({ where: { shipmentId: raceReserve.resourceId } });
  expect(['COMMITTED', 'RELEASED']).toContain(resolved.state);
  expect(await stockBalance(prisma, item.id)).toBe(resolved.state === 'RELEASED' ? 1 : 0);
});
