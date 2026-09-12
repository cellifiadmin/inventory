import { isHttpError } from 'http-errors';
import { INVENTORY_COMMAND, INVENTORY_RECOVERY, InventoryCommandState, WORKFLOW_ERROR, WORKFLOW_MESSAGE, WORKFLOW_OUTCOME, WORKFLOW_SCHEMA_VERSION, type InventoryCommandProducer } from '@/constants/inventoryWorkflows';
import { inventoryCommandEnvelopeSchema, inventoryOperationInputHash, inventoryResultEnvelopeSchema, type InventoryCommandEnvelope, type InventoryResultEnvelope } from '@/inventory/types/inventoryWorkflowEnvelope';
import { reserveStock } from '@/inventory/services/stockReservationService';
import { protectReservations } from '@/inventory/services/reservationProtectionService';
import { commitStock } from '@/inventory/services/stockCommitService';
import { releaseStock } from '@/inventory/services/stockReleaseService';
import { databaseNow, withStockTransaction, type InventoryStockTransaction } from '@/inventory/services/stockReservationShared';
import { canonicalWorkflowInput, workflowInputHash } from '@/inventory/services/workflows/workflowIdentity';

const applyCommand = (tx: InventoryStockTransaction, event: InventoryCommandEnvelope) => {
  switch (event.command) {
    case INVENTORY_COMMAND.RESERVE: return reserveStock({ ...event.input, operationId: event.operationId }, tx);
    case INVENTORY_COMMAND.PROTECT: return protectReservations({ ...event.input, operationId: event.operationId }, tx);
    case INVENTORY_COMMAND.COMMIT: return commitStock({ ...event.input, operationId: event.operationId }, tx);
    case INVENTORY_COMMAND.RELEASE: return releaseStock({ ...event.input, operationId: event.operationId }, tx);
  }
};
const resultScope = (event: InventoryCommandEnvelope) => ({
  type: WORKFLOW_MESSAGE.RESULT, schemaVersion: WORKFLOW_SCHEMA_VERSION, producer: 'inventory' as const,
  eventId: `${event.operationId}:result`, operationId: event.operationId, executionId: event.executionId,
  correlationId: event.correlationId, operationInputHash: event.operationInputHash,
  resourceType: event.resourceType, resourceId: event.resourceId, resourceVersion: event.resourceVersion,
} as const);

// expectedProducer is derived from an exact configured SQS source ARN by the handler.
export const consumeInventoryCommandInTransaction = async (
  tx: InventoryStockTransaction, rawInput: unknown, expectedProducer: InventoryCommandProducer,
): Promise<InventoryResultEnvelope> => {
  canonicalWorkflowInput(rawInput); // Bound plain JSON before parsing, retaining the owners' canonical rules.
  const event = inventoryCommandEnvelopeSchema.parse(rawInput);
  if (event.producer !== expectedProducer) throw new Error(WORKFLOW_ERROR.SOURCE_MISMATCH);
  if (inventoryOperationInputHash(event) !== event.operationInputHash) throw new Error(WORKFLOW_ERROR.HASH_MISMATCH);
  const { eventId: _eventId, ...immutableEnvelope } = event;
  const envelopeHash = workflowInputHash(immutableEnvelope);
  const payloadHash = workflowInputHash(event);
  const operationLock = `inventory-command:${event.operationId}`;
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${operationLock}, 0))`;
  let command = await tx.inventoryCommand.findUnique({ where: { operationId: event.operationId } });
  if (command && command.envelopeHash !== envelopeHash) throw new Error(WORKFLOW_ERROR.ENVELOPE_CONFLICT);
  if (!command) command = await tx.inventoryCommand.create({ data: {
    operationId: event.operationId, producer: event.producer, command: event.command,
    executionId: event.executionId, correlationId: event.correlationId,
    resourceType: event.resourceType, resourceId: event.resourceId, resourceVersion: event.resourceVersion,
    operationInputHash: event.operationInputHash, envelopeHash, immutableEnvelope,
  } });
  const insertedReceipt = await tx.inventoryInboxEvent.createMany({ skipDuplicates: true, data: [{
    producer: event.producer, eventId: event.eventId, operationId: event.operationId, payloadHash, payload: event,
  }] });
  const receipt = await tx.inventoryInboxEvent.findUniqueOrThrow({ where: { producer_eventId: { producer: event.producer, eventId: event.eventId } } });
  if (receipt.operationId !== event.operationId || receipt.payloadHash !== payloadHash) throw new Error(WORKFLOW_ERROR.INBOX_CONFLICT);
  if (command.state !== InventoryCommandState.RECEIVED) {
    const storedResult = inventoryResultEnvelopeSchema.parse(command.result);
    if (insertedReceipt.count) await tx.inventoryResultOutbox.create({ data: {
      operationId: event.operationId, receiptId: receipt.id, eventId: storedResult.eventId,
      destination: event.producer, payload: storedResult, payloadHash: workflowInputHash(storedResult),
    } });
    return storedResult;
  }
  const now = await databaseNow(tx);
  // A previously accepted domain operation may already have an authoritative result.
  const existingDomainOperation = await tx.reservationOperation.findUnique({ where: { id: event.operationId } });
  let result: InventoryResultEnvelope;
  if (!existingDomainOperation && new Date(event.deadlineAt) <= now) {
    if (event.command === INVENTORY_COMMAND.RESERVE) result = { ...resultScope(event), outcome: WORKFLOW_OUTCOME.FAILED,
      result: { errorCode: WORKFLOW_ERROR.DEADLINE_EXPIRED, recoveryRequired: false } };
    else {
      const recovery = await tx.inventoryCommandRecovery.create({ data: { operationId: event.operationId, reason: WORKFLOW_ERROR.RECONCILIATION_REQUIRED, assignedOwner: INVENTORY_RECOVERY.OWNER, severity: INVENTORY_RECOVERY.SEVERITY, nextAction: INVENTORY_RECOVERY.RECONCILE_ACTION, dueAt: now } });
      result = { ...resultScope(event), outcome: WORKFLOW_OUTCOME.UNKNOWN,
        result: { errorCode: WORKFLOW_ERROR.RECONCILIATION_REQUIRED, recoveryRequired: true, recoveryId: recovery.id } };
    }
  } else {
    await tx.$executeRaw`SAVEPOINT inventory_command_effects`;
    try {
      result = { ...resultScope(event), outcome: WORKFLOW_OUTCOME.SUCCEEDED, result: await applyCommand(tx, event) };
      await tx.$executeRaw`RELEASE SAVEPOINT inventory_command_effects`;
    } catch (error) {
      if (!isHttpError(error) || ![400, 403, 404, 409, 422].includes(error.statusCode)) throw error;
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT inventory_command_effects`;
      await tx.$executeRaw`RELEASE SAVEPOINT inventory_command_effects`;
      result = { ...resultScope(event), outcome: WORKFLOW_OUTCOME.FAILED,
        result: { errorCode: WORKFLOW_ERROR.DOMAIN_REJECTED, recoveryRequired: false } };
    }
  }
  await tx.inventoryResultOutbox.create({ data: { operationId: event.operationId, receiptId: receipt.id, eventId: result.eventId,
    destination: event.producer, payload: result, payloadHash: workflowInputHash(result) } });
  const state = result.outcome === WORKFLOW_OUTCOME.SUCCEEDED ? InventoryCommandState.SUCCEEDED
    : result.outcome === WORKFLOW_OUTCOME.FAILED ? InventoryCommandState.FAILED : InventoryCommandState.RECONCILING;
  await tx.inventoryCommand.update({ where: { operationId: event.operationId }, data: { state, result, completedAt: now } });
  return result;
};
export const consumeInventoryCommand = (rawInput: unknown, expectedProducer: InventoryCommandProducer) =>
  withStockTransaction(tx => consumeInventoryCommandInTransaction(tx, rawInput, expectedProducer));
