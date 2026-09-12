import { z } from 'zod';
import { INVENTORY_OWNER_EVENT as EVENT } from '@/constants/inventoryOwnerEvents';
import { WORKFLOW_SCHEMA_VERSION } from '@/constants/inventoryWorkflows';
import { canonicalInventoryDate } from '@/inventory/types/reservationScopeEvidence';
import { reservationResultSchema } from '@/inventory/types/stockReservationCommands';
import { canonicalWorkflowInput } from '@/inventory/services/workflows/workflowIdentity';

const identity = z.string().min(1).max(191);
const common = {
  type: z.literal(EVENT.TYPE),
  schemaVersion: z.literal(WORKFLOW_SCHEMA_VERSION),
  producer: z.literal('inventory'),
  eventId: identity,
  resourceType: z.literal('checkout'),
  resourceId: identity,
  resourceVersion: z.number().int().positive().safe(),
  observedAt: canonicalInventoryDate,
  reservation: reservationResultSchema,
};
const financialResolution = z
  .object({
    resolutionId: identity,
    paymentScopeId: identity,
    fence: z.number().int().positive().safe(),
    scopeClosedAt: canonicalInventoryDate,
    outcome: z.enum(['FAILED', 'CANCELLED', 'NOT_SUBMITTED']),
  })
  .strict();
export const inventoryOwnerEventSchema = z
  .discriminatedUnion('eventKind', [
    z
      .object({
        ...common,
        eventKind: z.literal(EVENT.EXPIRY),
        expiredReservationIds: z.array(identity).min(1),
      })
      .strict(),
    z
      .object({
        ...common,
        eventKind: z.literal(EVENT.COMMITTED),
        committedReservationIds: z.array(identity).min(1),
        commit: z
          .object({
            reservationOperationId: identity,
            paymentId: identity,
            purchaseId: identity,
            commerceSellerOrderId: identity,
            paymentScopeId: identity,
            fence: z.number().int().positive().safe(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...common,
        eventKind: z.literal(EVENT.RELEASED),
        releasedReservationIds: z.array(identity).min(1),
        release: z
          .object({
            reservationOperationId: identity,
            cause: z.enum(['payment_failed', 'cancelled']),
            financialResolution: financialResolution.nullable(),
          })
          .strict(),
      })
      .strict(),
  ])
  .superRefine((event, ctx) => {
    const invalid = () => ctx.addIssue({ code: z.ZodIssueCode.custom, message: EVENT.INVALID });
    const { reservation } = event;
    if (
      event.eventId !== `${reservation.scope.id}:revision:${reservation.scope.revision}` ||
      event.resourceId !== reservation.checkoutId ||
      event.resourceVersion !== reservation.version ||
      !canonicalInventoryDate.safeParse(reservation.expiresAt).success ||
      (event.eventKind === EVENT.EXPIRY &&
        new Date(event.observedAt) < new Date(reservation.expiresAt))
    )
      invalid();
    const ids =
      event.eventKind === EVENT.EXPIRY
        ? event.expiredReservationIds
        : event.eventKind === EVENT.COMMITTED
          ? event.committedReservationIds
          : event.releasedReservationIds;
    const state =
      event.eventKind === EVENT.EXPIRY
        ? 'EXPIRED'
        : event.eventKind === EVENT.COMMITTED
          ? 'COMMITTED'
          : 'RELEASED';
    if (
      new Set(ids).size !== ids.length ||
      [...ids].sort().some((id, index) => id !== ids[index]) ||
      ids.some(
        (id) =>
          !reservation.lines.some((line) => line.reservationId === id && line.state === state),
      )
    )
      invalid();
    for (const line of reservation.lines.filter((line) => ids.includes(line.reservationId))) {
      if (
        event.eventKind === EVENT.COMMITTED &&
        (line.paymentScopeId !== event.commit.paymentScopeId || line.fence !== event.commit.fence)
      )
        invalid();
      if (event.eventKind === EVENT.RELEASED && line.paymentScopeId !== null) {
        const proof = event.release.financialResolution;
        if (
          !proof ||
          proof.paymentScopeId !== line.paymentScopeId ||
          proof.fence !== line.fence ||
          proof.scopeClosedAt > event.observedAt
        )
          invalid();
      }
    }
    const movements = new Set<number>(),
      reservationIds = new Set<string>(),
      lineIds = new Set<string>();
    for (const line of reservation.lines) {
      if (
        reservationIds.has(line.reservationId) ||
        lineIds.has(line.lineId) ||
        line.expiresAt !== reservation.expiresAt ||
        !Number.isSafeInteger(line.quantity) ||
        !Number.isSafeInteger(line.revision) ||
        !Number.isSafeInteger(line.fence)
      )
        invalid();
      reservationIds.add(line.reservationId);
      lineIds.add(line.lineId);
      for (const movement of [line.heldMovementId, line.releasedMovementId, line.soldMovementId]) {
        if (movement !== null) {
          if (!Number.isSafeInteger(movement) || movements.has(movement)) invalid();
          movements.add(movement);
        }
      }
      const ordinary = line.paymentScopeId === null && line.fence === 0;
      const protectedLine = line.paymentScopeId !== null && line.fence > 0;
      const released = line.releasedMovementId !== null;
      const sold = line.soldMovementId !== null;
      switch (line.state) {
        case 'HELD':
          if (!ordinary || line.revision !== 0 || released || sold) invalid();
          break;
        case 'PAYMENT_LOCKED':
          if (!protectedLine || line.revision !== 1 || released || sold) invalid();
          break;
        case 'EXPIRED':
          if (!ordinary || line.revision !== 1 || !released || sold) invalid();
          break;
        case 'COMMITTED':
          if (!protectedLine || line.revision !== 2 || !released || !sold) invalid();
          break;
        case 'RELEASED':
          if (
            !((ordinary && line.revision === 1) || (protectedLine && line.revision === 2)) ||
            !released ||
            sold
          )
            invalid();
          break;
      }
    }
    try {
      canonicalWorkflowInput(event);
    } catch {
      invalid();
    }
  });
export type InventoryOwnerEventEnvelope = z.infer<typeof inventoryOwnerEventSchema>;
