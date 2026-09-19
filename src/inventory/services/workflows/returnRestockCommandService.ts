import { z } from 'zod';
import { InventoryCommandProducer } from '@/constants/inventoryWorkflows';
import { applyReturnRestock, returnRestockCommandInputSchema,
  returnRestockResultSchema } from '@/inventory/services/returnRestockService';
import { withStockTransaction } from '@/inventory/services/stockReservationShared';
import { canonicalWorkflowInput, workflowInputHash } from '@/inventory/services/workflows/workflowIdentity';

const id = z.string().trim().min(1).max(191);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const envelopeSchema = z.object({
  type: z.literal('WORKFLOW_COMMAND'), schemaVersion: z.literal(1),
  producer: z.literal(InventoryCommandProducer.fulfillment),
  command: z.literal('INVENTORY_APPLY_RETURN'), eventId: id,
  operationId: z.string().trim().min(1).max(160), executionId: id, correlationId: id,
  operationInputHash: hash, workflowKind: z.literal('RETURN_RESTOCK'),
  stepKey: z.literal('INVENTORY_APPLY_RETURN'), participantKey: id,
  resourceType: z.literal('return'), resourceId: id, resourceVersion: z.literal(1),
  actorIdentifier: id, deadlineAt: z.string().datetime({ offset: true }),
  input: returnRestockCommandInputSchema,
}).strict().superRefine((event, ctx) => {
  const expected = workflowInputHash({ kind: event.workflowKind, resourceType: event.resourceType,
    resourceId: event.resourceId, resourceVersion: event.resourceVersion, stepKey: event.stepKey,
    participantKey: event.participantKey, input: event.input, deadlineAt: event.deadlineAt });
  if (event.resourceId !== event.input.returnId ||
    event.participantKey !== `inventory:${event.input.sellerAccountId}` ||
    event.operationInputHash !== expected)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Return restock command scope invalid' });
});
const resultSchema = z.object({ type: z.literal('WORKFLOW_RESULT'), schemaVersion: z.literal(1),
  producer: z.literal('inventory'), eventId: id, operationId: z.string().max(160), executionId: id,
  correlationId: id, operationInputHash: hash, resourceType: z.literal('return'),
  resourceId: id, resourceVersion: z.literal(1), outcome: z.literal('SUCCEEDED'),
  result: returnRestockResultSchema }).strict();

export const parseReturnRestockCommand = (input: unknown) => envelopeSchema.parse(input);

export const consumeReturnRestockCommand = (rawInput: unknown, expectedProducer: InventoryCommandProducer) => {
  const event = parseReturnRestockCommand(rawInput);
  if (expectedProducer !== InventoryCommandProducer.fulfillment)
    throw new Error('INVENTORY_COMMAND_SOURCE_MISMATCH');
  return withStockTransaction(async (tx) => {
    const { eventId: _eventId, ...immutableEnvelope } = event;
    const envelopeHash = workflowInputHash(immutableEnvelope);
    const payloadHash = workflowInputHash(event);
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
    if (command.state === 'SUCCEEDED') {
      const stored = resultSchema.parse(command.result);
      if (inserted.count) await tx.inventoryResultOutbox.create({ data: { operationId: event.operationId,
        receiptId: receipt.id, eventId: stored.eventId, destination: event.producer,
        payload: stored, payloadHash: workflowInputHash(stored) } });
      return stored;
    }
    if (command.state !== 'RECEIVED') throw new Error('RETURN_RESTOCK_COMMAND_TERMINAL');
    const result = resultSchema.parse({ type: 'WORKFLOW_RESULT', schemaVersion: 1, producer: 'inventory',
      eventId: `${event.operationId}:result`, operationId: event.operationId,
      executionId: event.executionId, correlationId: event.correlationId,
      operationInputHash: event.operationInputHash, resourceType: event.resourceType,
      resourceId: event.resourceId, resourceVersion: event.resourceVersion, outcome: 'SUCCEEDED',
      result: await applyReturnRestock({ ...event.input, operationId: event.operationId }, tx) });
    await tx.inventoryResultOutbox.create({ data: { operationId: event.operationId, receiptId: receipt.id,
      eventId: result.eventId, destination: event.producer, payload: result,
      payloadHash: workflowInputHash(result) } });
    await tx.inventoryCommand.update({ where: { operationId: event.operationId },
      data: { state: 'SUCCEEDED', result: JSON.parse(canonicalWorkflowInput(result)), completedAt: new Date() } });
    return result;
  });
};
