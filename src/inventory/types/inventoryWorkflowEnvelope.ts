import { z } from 'zod';
import { INVENTORY_COMMAND, InventoryCommandProducer, WORKFLOW_MESSAGE, WORKFLOW_OUTCOME, WORKFLOW_SCHEMA_VERSION } from '@/constants/inventoryWorkflows';
import { reserveStockSchema, protectReservationsSchema, releaseStockSchema, commitStockSchema, reservationResultSchema } from '@/inventory/types/stockReservationCommands';
import { workflowInputHash } from '@/inventory/services/workflows/workflowIdentity';

const identifier = z.string().trim().min(1).max(191);
const revision = z.number().int().positive().safe();
const envelope = z.object({
  type: z.literal(WORKFLOW_MESSAGE.COMMAND), schemaVersion: z.literal(WORKFLOW_SCHEMA_VERSION),
  producer: z.nativeEnum(InventoryCommandProducer), eventId: identifier, operationId: z.string().trim().min(1).max(160),
  executionId: identifier, correlationId: identifier, operationInputHash: z.string().regex(/^[a-f0-9]{64}$/),
  workflowKind: identifier, stepKey: identifier, participantKey: identifier,
  resourceType: identifier, resourceId: identifier, resourceVersion: revision, actorIdentifier: identifier,
  deadlineAt: z.string().datetime({ offset: true }),
});
export const inventoryCommandEnvelopeSchema = z.discriminatedUnion('command', [
  envelope.extend({ command: z.literal(INVENTORY_COMMAND.RESERVE), input: reserveStockSchema.omit({ operationId: true }) }).strict(),
  envelope.extend({ command: z.literal(INVENTORY_COMMAND.PROTECT), input: protectReservationsSchema.omit({ operationId: true }) }).strict(),
  envelope.extend({ command: z.literal(INVENTORY_COMMAND.RELEASE), input: releaseStockSchema.omit({ operationId: true }) }).strict(),
  envelope.extend({ command: z.literal(INVENTORY_COMMAND.COMMIT), input: commitStockSchema.omit({ operationId: true }) }).strict(),
]).superRefine((event, ctx) => {
  const commit = event.command === INVENTORY_COMMAND.COMMIT;
  const producer = commit ? InventoryCommandProducer.fulfillment : InventoryCommandProducer.commerce;
  const resourceMatches = commit
    ? event.resourceType === 'seller_order' && event.resourceId === event.input.commerceSellerOrderId
    : event.resourceType === 'checkout' && event.resourceId === event.input.checkoutId && event.resourceVersion === event.input.version;
  if (event.producer !== producer || !resourceMatches || event.stepKey !== event.command
    || !event.participantKey.startsWith('inventory:') || event.participantKey === 'inventory:'
    || (event.command === INVENTORY_COMMAND.RESERVE && event.participantKey !== `inventory:checkout:${event.resourceId}`)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Inventory command scope invalid' });
  }
});
export type InventoryCommandEnvelope = z.infer<typeof inventoryCommandEnvelopeSchema>;

export const inventoryOperationInputHash = (event: Omit<InventoryCommandEnvelope, 'operationInputHash'>) => workflowInputHash({
  kind: event.workflowKind, resourceType: event.resourceType, resourceId: event.resourceId, resourceVersion: event.resourceVersion,
  stepKey: event.stepKey, participantKey: event.participantKey, input: event.input, deadlineAt: event.deadlineAt,
});
const result = z.object({
  type: z.literal(WORKFLOW_MESSAGE.RESULT), schemaVersion: z.literal(WORKFLOW_SCHEMA_VERSION), producer: z.literal('inventory'),
  eventId: z.string().min(1).max(191), operationId: z.string().trim().min(1).max(160), executionId: identifier, correlationId: identifier,
  operationInputHash: z.string().regex(/^[a-f0-9]{64}$/), resourceType: identifier, resourceId: identifier, resourceVersion: revision,
});
export const inventoryResultEnvelopeSchema = z.discriminatedUnion('outcome', [
  result.extend({ outcome: z.literal(WORKFLOW_OUTCOME.SUCCEEDED), result: reservationResultSchema }).strict(),
  result.extend({ outcome: z.literal(WORKFLOW_OUTCOME.FAILED), result: z.object({ errorCode: identifier, recoveryRequired: z.literal(false) }).strict() }).strict(),
  result.extend({ outcome: z.literal(WORKFLOW_OUTCOME.UNKNOWN), result: z.object({ errorCode: identifier, recoveryRequired: z.literal(true), recoveryId: identifier }).strict() }).strict(),
]);
export type InventoryResultEnvelope = z.infer<typeof inventoryResultEnvelopeSchema>;
