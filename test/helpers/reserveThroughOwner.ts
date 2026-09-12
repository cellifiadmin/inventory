import prisma from '@/lib/prismaInventory';
import {
  consumeInventoryCommand,
  consumeInventoryCommandInTransaction,
} from '@/inventory/services/workflows/inventoryCommandService';
import {
  inventoryOperationInputHash,
  type InventoryCommandEnvelope,
} from '@/inventory/types/inventoryWorkflowEnvelope';
import type {
  ReserveStockInput,
  ReservationResult,
} from '@/inventory/types/stockReservationCommands';
import type { InventoryStockTransaction } from '@/inventory/services/stockReservationShared';
import { SYNTHETIC_HOLD_DURATION_MS } from './reservationFixtures';
// Tests enter the real trusted consumer. No command, scope or inbox row is fabricated.
export const reserveStock = async (
  input: ReserveStockInput,
  tx?: InventoryStockTransaction,
): Promise<ReservationResult> => {
  const { operationId, ...reserveInput } = input;
  const descriptor = {
    type: 'WORKFLOW_COMMAND' as const,
    schemaVersion: 1 as const,
    producer: 'commerce' as const,
    command: 'INVENTORY_RESERVE' as const,
    eventId: `${operationId}:receipt`,
    operationId,
    executionId: `${operationId}:execution`,
    correlationId: `${operationId}:correlation`,
    workflowKind: 'PURCHASE_PLACEMENT',
    stepKey: 'INVENTORY_RESERVE',
    participantKey: `inventory:checkout:${input.checkoutId}`,
    resourceType: 'checkout',
    resourceId: input.checkoutId,
    resourceVersion: input.version,
    actorIdentifier: 'synthetic-test-buyer',
    deadlineAt: new Date(
      new Date(input.expiresAt).getTime() + SYNTHETIC_HOLD_DURATION_MS,
    ).toISOString(),
    input: reserveInput,
  };
  const event: InventoryCommandEnvelope = {
    ...descriptor,
    operationInputHash: inventoryOperationInputHash(descriptor),
  };
  const result = tx
    ? await consumeInventoryCommandInTransaction(tx, event, 'commerce')
    : await consumeInventoryCommand(event, 'commerce');
  if (result.outcome !== 'SUCCEEDED') throw new Error(result.result.errorCode);
  if (!('lines' in result.result)) throw new Error('Expected reservation fixture result');
  return result.result;
};
export const cleanupReservationScopeFixture = async (checkoutPrefix: string) => {
  const where = { checkoutId: { startsWith: checkoutPrefix } };
  const ids = (
    await prisma.inventoryCommand.findMany({
      where: { resourceType: 'checkout', resourceId: { startsWith: checkoutPrefix } },
    })
  ).map((row) => row.operationId);
  await prisma.inventoryResultOutbox.deleteMany({ where: { operationId: { in: ids } } });
  await prisma.inventoryInboxEvent.deleteMany({ where: { operationId: { in: ids } } });
  await prisma.inventoryCommandRecovery.deleteMany({ where: { operationId: { in: ids } } });
  await prisma.inventoryReserveNoEffectClosure.deleteMany({ where: { scope: where } });
  await prisma.stockReservation.deleteMany({ where });
  await prisma.reservationOperation.deleteMany({ where });
  await prisma.inventoryReserveScopeLine.deleteMany({ where });
  await prisma.inventoryReserveScope.deleteMany({ where });
  await prisma.inventoryCommand.deleteMany({ where: { operationId: { in: ids } } });
};
