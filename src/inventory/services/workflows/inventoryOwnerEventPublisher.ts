import { randomUUID } from 'node:crypto';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { Prisma } from '@/lib/prismaInventoryTypes';
import { INVENTORY_OWNER_EVENT as EVENT } from '@/constants/inventoryOwnerEvents';
import {
  INVENTORY_RECOVERY,
  INVENTORY_RESULT_DELIVERY as DELIVERY,
  INVENTORY_WORKFLOW_ENV as ENV,
  InventoryResultDeliveryState as STATE,
  WORKFLOW_ERROR,
} from '@/constants/inventoryWorkflows';
import { resolveAwsClientConfig } from '@/lib/awsClientConfig';
import {
  databaseNow,
  withStockTransaction,
  type InventoryStockTransaction,
} from '@/inventory/services/stockReservationShared';
import { inventoryOwnerEventSchema } from '@/inventory/types/inventoryOwnerEvent';
import {
  canonicalWorkflowInput,
  workflowInputHash,
} from '@/inventory/services/workflows/workflowIdentity';

export type InventoryOwnerEventDelivery = Prisma.InventoryOwnerEventOutboxGetPayload<{
  include: { event: true };
}>;
const include = { event: true } as const;

const sqs = new SQSClient({ ...resolveAwsClientConfig(), maxAttempts: 2 });
export const sendInventoryOwnerEvent = async (row: InventoryOwnerEventDelivery): Promise<void> => {
  const payload = inventoryOwnerEventSchema.parse(row.event.payload);
  if (
    workflowInputHash(payload) !== row.event.payloadHash ||
    payload.eventId !== row.eventId ||
    payload.eventId !== row.event.id ||
    payload.reservation.scope.id !== row.event.scopeId ||
    payload.reservation.scope.revision !== row.event.scopeRevision ||
    payload.resourceId !== row.event.checkoutId ||
    payload.resourceVersion !== row.event.checkoutVersion ||
    payload.eventKind !== row.event.kind ||
    payload.observedAt !== row.event.observedAt.toISOString()
  )
    throw new Error(EVENT.INVALID);
  const queueUrl = process.env[ENV.COMMERCE_RESULT_URL]?.trim();
  try {
    const url = new URL(queueUrl!);
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname.endsWith('.fifo'))
      throw new Error();
  } catch {
    throw new Error(WORKFLOW_ERROR.DELIVERY_CONFIGURATION);
  }
  const accepted = await sqs.send(
    new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: canonicalWorkflowInput(payload) }),
    { abortSignal: AbortSignal.timeout(20000) },
  );
  if (typeof accepted.MessageId !== 'string' || !accepted.MessageId.trim())
    throw new Error(WORKFLOW_ERROR.DELIVERY_UNAVAILABLE);
};

export const claimInventoryOwnerEvent = (transaction?: InventoryStockTransaction) =>
  withStockTransaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM inventory_owner_event_outbox
    WHERE (state = 'PENDING' AND next_attempt_at <= clock_timestamp()) OR (state = 'SENDING' AND lease_expires_at <= clock_timestamp())
    ORDER BY next_attempt_at, id FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!rows.length) return null;
    const now = await databaseNow(tx);
    const row = await tx.inventoryOwnerEventOutbox.findUniqueOrThrow({
      where: { id: rows[0].id },
      include,
    });
    if (row.attempts >= DELIVERY.MAX_ATTEMPTS) {
      await tx.inventoryOwnerEventOutbox.update({
        where: { id: row.id },
        data: {
          state: STATE.EXHAUSTED,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: WORKFLOW_ERROR.DELIVERY_EXHAUSTED,
        },
      });
      await tx.inventoryOwnerEventRecovery.upsert({
        where: {
          eventId_reason: { eventId: row.eventId, reason: WORKFLOW_ERROR.DELIVERY_EXHAUSTED },
        },
        create: {
          eventId: row.eventId,
          reason: WORKFLOW_ERROR.DELIVERY_EXHAUSTED,
          assignedOwner: INVENTORY_RECOVERY.OWNER,
          severity: INVENTORY_RECOVERY.SEVERITY,
          nextAction: EVENT.RECOVERY_ACTION,
          dueAt: now,
        },
        update: {},
      });
      return { exhausted: true as const };
    }
    return tx.inventoryOwnerEventOutbox.update({
      where: { id: row.id },
      include,
      data: {
        state: STATE.SENDING,
        attempts: { increment: 1 },
        leaseOwner: randomUUID(),
        leaseExpiresAt: new Date(now.getTime() + DELIVERY.LEASE_MS),
        fencingToken: { increment: 1 },
      },
    });
  }, transaction);

export const settleInventoryOwnerEvent = (claim: InventoryOwnerEventDelivery, delivered: boolean) =>
  withStockTransaction(async (tx) => {
    const now = await databaseNow(tx);
    const exhausted = !delivered && claim.attempts >= DELIVERY.MAX_ATTEMPTS;
    const updated = await tx.inventoryOwnerEventOutbox.updateMany({
      where: {
        id: claim.id,
        state: STATE.SENDING,
        leaseOwner: claim.leaseOwner,
        fencingToken: claim.fencingToken,
        leaseExpiresAt: { gt: now },
      },
      data: {
        state: delivered ? STATE.DELIVERED : exhausted ? STATE.EXHAUSTED : STATE.PENDING,
        deliveredAt: delivered ? now : null,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: delivered
          ? null
          : exhausted
            ? WORKFLOW_ERROR.DELIVERY_EXHAUSTED
            : WORKFLOW_ERROR.DELIVERY_UNAVAILABLE,
        nextAttemptAt: new Date(
          now.getTime() +
            Math.min(DELIVERY.RETRY_MAX_MS, DELIVERY.RETRY_BASE_MS * 2 ** (claim.attempts - 1)),
        ),
      },
    });
    if (!updated.count) throw new Error(WORKFLOW_ERROR.STALE_DELIVERY);
    if (exhausted)
      await tx.inventoryOwnerEventRecovery.upsert({
        where: {
          eventId_reason: { eventId: claim.eventId, reason: WORKFLOW_ERROR.DELIVERY_EXHAUSTED },
        },
        create: {
          eventId: claim.eventId,
          reason: WORKFLOW_ERROR.DELIVERY_EXHAUSTED,
          assignedOwner: INVENTORY_RECOVERY.OWNER,
          severity: INVENTORY_RECOVERY.SEVERITY,
          nextAction: EVENT.RECOVERY_ACTION,
          dueAt: now,
        },
        update: {},
      });
  });

export const publishInventoryOwnerEvents = async (
  send: (row: InventoryOwnerEventDelivery) => Promise<void> = sendInventoryOwnerEvent,
) => {
  let delivered = 0;
  const stopAt = Date.now() + DELIVERY.BATCH_TIME_BUDGET_MS;
  for (let index = 0; index < DELIVERY.BATCH_SIZE; index += 1) {
    if (Date.now() >= stopAt) break;
    const claim = await claimInventoryOwnerEvent();
    if (!claim) break;
    if ('exhausted' in claim) continue;
    let accepted = false;
    try {
      await send(claim);
      accepted = true;
    } catch {
      /* Retry uses the same immutable event identity. */
    }
    // An acknowledgement failure must leave the lease intact; it is not a rejected send.
    await settleInventoryOwnerEvent(claim, accepted);
    if (accepted) delivered += 1;
  }
  return { delivered };
};
