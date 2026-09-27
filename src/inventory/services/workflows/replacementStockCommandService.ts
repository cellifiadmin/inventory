import { z } from 'zod';
import { InventoryCommandProducer } from '@/constants/inventoryWorkflows';
import { databaseNow, withStockTransaction } from '@/inventory/services/stockReservationShared';
import { replacementReserveInputSchema, replacementReserveResultSchema,
  reserveReplacementStock } from '@/inventory/services/replacementStockService';
import { canonicalWorkflowInput, workflowInputHash } from '@/inventory/services/workflows/workflowIdentity';

const id = z.string().trim().min(1).max(191);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const envelopeSchema = z.object({ type: z.literal('WORKFLOW_COMMAND'), schemaVersion: z.literal(1),
  producer: z.literal(InventoryCommandProducer.fulfillment),
  command: z.literal('INVENTORY_RESERVE_REPLACEMENT'), eventId: id,
  operationId: z.string().min(1).max(160), executionId: id, correlationId: id,
  operationInputHash: hash, workflowKind: z.literal('REPLACEMENT_STOCK'),
  stepKey: z.literal('INVENTORY_RESERVE_REPLACEMENT'), participantKey: id,
  resourceType: z.literal('replacement-shipment'), resourceId: id, resourceVersion: z.literal(1),
  actorIdentifier: id, deadlineAt: z.string().datetime({ offset: true }),
  input: replacementReserveInputSchema }).strict().superRefine((event, ctx) => {
    const expected = workflowInputHash({ kind: event.workflowKind, resourceType: event.resourceType,
      resourceId: event.resourceId, resourceVersion: event.resourceVersion, stepKey: event.stepKey,
      participantKey: event.participantKey, input: event.input, deadlineAt: event.deadlineAt });
    if (event.operationId !== `replacement:${event.input.shipmentId}:reserve:v1` ||
      event.resourceId !== event.input.shipmentId ||
      event.executionId !== `replacement:${event.input.shipmentId}` ||
      event.correlationId !== event.input.sellerOrderId ||
      event.participantKey !== `inventory:${event.input.sellerAccountId}` ||
      event.operationInputHash !== expected)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Replacement stock command scope invalid' });
  });
const commonResult = { type: z.literal('WORKFLOW_RESULT'), schemaVersion: z.literal(1),
  producer: z.literal('inventory'), eventId: id, operationId: z.string().max(160),
  executionId: id, correlationId: id, operationInputHash: hash,
  resourceType: z.literal('replacement-shipment'), resourceId: id, resourceVersion: z.literal(1) };
export const replacementStockResultSchema = z.discriminatedUnion('outcome', [
  z.object({ ...commonResult, outcome: z.literal('SUCCEEDED'), result: replacementReserveResultSchema }).strict(),
  z.object({ ...commonResult, outcome: z.literal('FAILED'), result: z.object({
    errorCode: id, recoveryRequired: z.literal(false), noEffect: z.null() }).strict() }).strict(),
]);
const noEffectErrors = new Set(['REPLACEMENT_STOCK_ITEM_NOT_FOUND', 'REPLACEMENT_STOCK_SALE_NOT_FOUND',
  'REPLACEMENT_STOCK_UNAVAILABLE', 'SERIALIZED_SALE_QUANTITY_INVALID']);

export const consumeReplacementStockCommand = (rawInput: unknown, expectedProducer: InventoryCommandProducer) => {
  const event = envelopeSchema.parse(rawInput);
  if (expectedProducer !== InventoryCommandProducer.fulfillment)
    throw new Error('INVENTORY_COMMAND_SOURCE_MISMATCH');
  return withStockTransaction(async (tx) => {
    const { eventId: _eventId, ...immutableEnvelope } = event;
    const envelopeHash = workflowInputHash(immutableEnvelope), payloadHash = workflowInputHash(event);
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`inventory-command:${event.operationId}`}, 0))`;
    let command = await tx.inventoryCommand.findUnique({ where: { operationId: event.operationId } });
    if (command && command.envelopeHash !== envelopeHash) throw new Error('INVENTORY_COMMAND_ENVELOPE_CONFLICT');
    if (!command) command = await tx.inventoryCommand.create({ data: { operationId: event.operationId,
      producer: event.producer, command: event.command, executionId: event.executionId,
      correlationId: event.correlationId, resourceType: event.resourceType, resourceId: event.resourceId,
      resourceVersion: event.resourceVersion, operationInputHash: event.operationInputHash,
      envelopeHash, immutableEnvelope } });
    const inserted = await tx.inventoryInboxEvent.createMany({ skipDuplicates: true,
      data: [{ producer: event.producer, eventId: event.eventId, operationId: event.operationId,
        payloadHash, payload: event }] });
    const receipt = await tx.inventoryInboxEvent.findUniqueOrThrow({ where: {
      producer_eventId: { producer: event.producer, eventId: event.eventId } } });
    if (receipt.operationId !== event.operationId || receipt.payloadHash !== payloadHash)
      throw new Error('INVENTORY_INBOX_CONFLICT');
    if (command.state === 'SUCCEEDED' || command.state === 'FAILED') {
      const retained = replacementStockResultSchema.parse(command.result);
      if (inserted.count) await tx.inventoryResultOutbox.create({ data: { operationId: event.operationId,
        receiptId: receipt.id, eventId: retained.eventId, destination: event.producer,
        payload: retained, payloadHash: workflowInputHash(retained) } });
      return retained;
    }
    if (command.state !== 'RECEIVED') throw new Error('REPLACEMENT_STOCK_COMMAND_TERMINAL');
    let outcome: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED';
    let result: unknown;
    try {
      if (new Date(event.deadlineAt) <= await databaseNow(tx))
        throw new Error('REPLACEMENT_STOCK_DEADLINE_EXPIRED');
      result = await reserveReplacementStock({ operationId: event.operationId, ...event.input }, tx);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (!noEffectErrors.has(code) && code !== 'REPLACEMENT_STOCK_DEADLINE_EXPIRED') throw error;
      outcome = 'FAILED'; result = { errorCode: code, recoveryRequired: false, noEffect: null };
    }
    const response = replacementStockResultSchema.parse({ type: 'WORKFLOW_RESULT', schemaVersion: 1,
      producer: 'inventory', eventId: `${event.operationId}:result`, operationId: event.operationId,
      executionId: event.executionId, correlationId: event.correlationId,
      operationInputHash: event.operationInputHash, resourceType: event.resourceType,
      resourceId: event.resourceId, resourceVersion: 1, outcome, result });
    await tx.inventoryResultOutbox.create({ data: { operationId: event.operationId, receiptId: receipt.id,
      eventId: response.eventId, destination: event.producer,
      payload: response, payloadHash: workflowInputHash(response) } });
    await tx.inventoryCommand.update({ where: { operationId: event.operationId },
      data: { state: outcome, result: JSON.parse(canonicalWorkflowInput(response)), completedAt: new Date() } });
    return response;
  });
};
