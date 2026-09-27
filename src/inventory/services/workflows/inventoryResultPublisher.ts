import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { InventoryResultOutbox } from '.prisma/inventoryClient';
import { INVENTORY_RECOVERY, INVENTORY_RESULT_DELIVERY as DELIVERY, INVENTORY_WORKFLOW_ENV as ENV, InventoryCommandProducer, InventoryResultDeliveryState as STATE, WORKFLOW_ERROR } from '@/constants/inventoryWorkflows';
import { resolveAwsClientConfig } from '@/lib/awsClientConfig';
import { databaseNow, withStockTransaction, type InventoryStockTransaction } from '@/inventory/services/stockReservationShared';
import { inventoryResultEnvelopeSchema } from '@/inventory/types/inventoryWorkflowEnvelope';
import { returnRestockResultSchema } from '@/inventory/services/returnRestockService';
import { cancellationRestorationResultSchema } from '@/inventory/services/cancellationRestorationService';
import { replacementStockResultSchema } from '@/inventory/services/workflows/replacementStockCommandService';
import { canonicalWorkflowInput, workflowInputHash } from '@/inventory/services/workflows/workflowIdentity';

const sqs = new SQSClient({ ...resolveAwsClientConfig(), maxAttempts: 2 });
const ownerResultFields = { type: z.literal('WORKFLOW_RESULT'), schemaVersion: z.literal(1),
  producer: z.literal('inventory'), eventId: z.string().min(1).max(191),
  operationId: z.string().min(1).max(160), executionId: z.string().min(1).max(191),
  correlationId: z.string().min(1).max(191), operationInputHash: z.string().regex(/^[a-f0-9]{64}$/),
  resourceId: z.string().min(1).max(191), resourceVersion: z.literal(1),
  outcome: z.literal('SUCCEEDED') };
const fulfillmentOwnerResultSchema = z.discriminatedUnion('resourceType', [
  z.object({ ...ownerResultFields, resourceType: z.literal('return'), result: returnRestockResultSchema }).strict(),
  z.object({ ...ownerResultFields, resourceType: z.literal('cancellation'), result: cancellationRestorationResultSchema }).strict(),
]);
export const sendInventoryResult = async (row: InventoryResultOutbox): Promise<void> => {
  const resourceType = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
    ? (row.payload as { resourceType?: unknown }).resourceType : null;
  const fulfillmentOwner = resourceType === 'return' || resourceType === 'cancellation' ||
    resourceType === 'replacement-shipment';
  if (fulfillmentOwner && row.destination !== InventoryCommandProducer.fulfillment)
    throw new Error(WORKFLOW_ERROR.RESULT_INVALID);
  const payload = resourceType === 'replacement-shipment' ? replacementStockResultSchema.parse(row.payload)
    : fulfillmentOwner ? fulfillmentOwnerResultSchema.parse(row.payload)
      : inventoryResultEnvelopeSchema.parse(row.payload);
  if (workflowInputHash(payload) !== row.payloadHash || payload.operationId !== row.operationId || payload.eventId !== row.eventId) {
    throw new Error(WORKFLOW_ERROR.RESULT_INVALID);
  }
  const queueUrl = process.env[row.destination === InventoryCommandProducer.commerce ? ENV.COMMERCE_RESULT_URL : ENV.FULFILLMENT_RESULT_URL]?.trim();
  if (!queueUrl) throw new Error(WORKFLOW_ERROR.DELIVERY_CONFIGURATION);
  const accepted = await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: canonicalWorkflowInput(payload),
  }), { abortSignal: AbortSignal.timeout(20000) });
  if (typeof accepted.MessageId !== 'string' || !accepted.MessageId.trim()) throw new Error(WORKFLOW_ERROR.DELIVERY_UNAVAILABLE);
};

export const claimInventoryResult = (transaction?: InventoryStockTransaction) => withStockTransaction(async tx => {
  const now = await databaseNow(tx);
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM inventory_result_outbox
    WHERE (state = 'PENDING' AND next_attempt_at <= clock_timestamp()) OR (state = 'SENDING' AND lease_expires_at <= clock_timestamp())
    ORDER BY next_attempt_at, id FOR UPDATE SKIP LOCKED LIMIT 1`;
  if (!rows.length) return null;
  const row = await tx.inventoryResultOutbox.findUniqueOrThrow({ where: { id: rows[0].id } });
  if (row.attempts >= DELIVERY.MAX_ATTEMPTS) {
    await tx.inventoryResultOutbox.update({ where: { id: row.id }, data: { state: STATE.EXHAUSTED, leaseOwner: null, leaseExpiresAt: null, lastErrorCode: WORKFLOW_ERROR.DELIVERY_EXHAUSTED } });
    await tx.inventoryCommandRecovery.upsert({ where: { operationId_reason: { operationId: row.operationId, reason: WORKFLOW_ERROR.DELIVERY_EXHAUSTED } },
      create: { operationId: row.operationId, reason: WORKFLOW_ERROR.DELIVERY_EXHAUSTED, assignedOwner: INVENTORY_RECOVERY.OWNER, severity: INVENTORY_RECOVERY.SEVERITY, nextAction: INVENTORY_RECOVERY.DELIVERY_ACTION, dueAt: now }, update: {} });
    return { exhausted: true as const };
  }
  return tx.inventoryResultOutbox.update({ where: { id: row.id }, data: { state: STATE.SENDING, attempts: { increment: 1 },
    leaseOwner: randomUUID(), leaseExpiresAt: new Date(now.getTime() + DELIVERY.LEASE_MS), fencingToken: { increment: 1 } } });
}, transaction);

export const settleInventoryResult = (claim: InventoryResultOutbox, delivered: boolean) => withStockTransaction(async tx => {
  const now = await databaseNow(tx);
  const exhausted = !delivered && claim.attempts >= DELIVERY.MAX_ATTEMPTS;
  const updated = await tx.inventoryResultOutbox.updateMany({ where: { id: claim.id, state: STATE.SENDING,
    leaseOwner: claim.leaseOwner, fencingToken: claim.fencingToken, leaseExpiresAt: { gt: now } }, data: {
    state: delivered ? STATE.DELIVERED : exhausted ? STATE.EXHAUSTED : STATE.PENDING,
    deliveredAt: delivered ? now : null, leaseOwner: null, leaseExpiresAt: null,
    lastErrorCode: delivered ? null : exhausted ? WORKFLOW_ERROR.DELIVERY_EXHAUSTED : WORKFLOW_ERROR.DELIVERY_UNAVAILABLE,
    nextAttemptAt: new Date(now.getTime() + Math.min(DELIVERY.RETRY_MAX_MS, DELIVERY.RETRY_BASE_MS * 2 ** (claim.attempts - 1))),
  } });
  if (!updated.count) throw new Error(WORKFLOW_ERROR.STALE_DELIVERY);
  if (exhausted) await tx.inventoryCommandRecovery.upsert({ where: { operationId_reason: { operationId: claim.operationId, reason: WORKFLOW_ERROR.DELIVERY_EXHAUSTED } },
    create: { operationId: claim.operationId, reason: WORKFLOW_ERROR.DELIVERY_EXHAUSTED, assignedOwner: INVENTORY_RECOVERY.OWNER, severity: INVENTORY_RECOVERY.SEVERITY, nextAction: INVENTORY_RECOVERY.DELIVERY_ACTION, dueAt: now }, update: {} });
});

export const publishInventoryResults = async (send: (row: InventoryResultOutbox) => Promise<void> = sendInventoryResult) => {
  let delivered = 0;
  const stopAt = Date.now() + DELIVERY.BATCH_TIME_BUDGET_MS;
  for (let index = 0; index < DELIVERY.BATCH_SIZE; index += 1) {
    if (Date.now() >= stopAt) break;
    const claim = await claimInventoryResult();
    if (!claim) break;
    if ('exhausted' in claim) continue;
    let accepted = false;
    try { await send(claim); accepted = true; } catch { /* Retry uses the same immutable event identity. */ }
    // An acknowledgement failure must leave the lease intact; it is not a rejected send.
    await settleInventoryResult(claim, accepted);
    if (accepted) delivered += 1;
  }
  return { delivered };
};
