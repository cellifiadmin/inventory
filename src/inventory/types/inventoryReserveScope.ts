import { z } from 'zod';
import {
  reserveStockSchema,
  reservationResultSchema,
} from '@/inventory/types/stockReservationCommands';
import {
  canonicalInventoryDate,
  reserveNoEffectProofSchema,
} from '@/inventory/types/reservationScopeEvidence';
import { workflowInputHash } from '@/inventory/services/workflows/workflowIdentity';
const identity = z.string().trim().min(1).max(191);
const version = z.number().int().positive().safe();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const originalReserveDescriptorSchema = z
  .object({
    type: z.literal('WORKFLOW_COMMAND'),
    schemaVersion: z.literal(1),
    producer: z.literal('commerce'),
    command: z.literal('INVENTORY_RESERVE'),
    operationId: z.string().trim().min(1).max(160),
    executionId: identity,
    correlationId: identity,
    operationInputHash: hash,
    workflowKind: identity,
    stepKey: z.literal('INVENTORY_RESERVE'),
    participantKey: identity,
    resourceType: z.literal('checkout'),
    resourceId: identity,
    resourceVersion: version,
    actorIdentifier: identity,
    deadlineAt: z.string().datetime({ offset: true }),
    input: reserveStockSchema.omit({ operationId: true }),
  })
  .strict()
  .superRefine((event, ctx) => {
    const expected = workflowInputHash({
      kind: event.workflowKind,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      resourceVersion: event.resourceVersion,
      stepKey: event.stepKey,
      participantKey: event.participantKey,
      input: event.input,
      deadlineAt: event.deadlineAt,
    });
    if (
      event.resourceId !== event.input.checkoutId ||
      event.resourceVersion !== event.input.version ||
      event.participantKey !== `inventory:checkout:${event.resourceId}` ||
      event.operationInputHash !== expected
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Original reserve scope invalid' });
    }
  });
export const observeReserveScopeSchema = z
  .object({
    checkoutId: identity,
    version,
    reserveOperationId: identity,
    reserveOperationInputHash: hash,
    reserveInputHash: hash,
  })
  .strict();
// Outer envelope scope is checked by the command validator; no reference creates an inbox receipt.
export const closeReserveScopeSchema = z
  .object({
    checkoutId: identity,
    version,
    originalReserve: originalReserveDescriptorSchema,
    reason: z.literal('CANCELLED'),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (
      input.checkoutId !== input.originalReserve.input.checkoutId ||
      input.version !== input.originalReserve.input.version
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Close reserve scope invalid' });
    }
  });
export const reserveScopeObservationSchema = z.discriminatedUnion('evidenceKind', [
  z
    .object({
      evidenceKind: z.literal('CURRENT_RESERVATION'),
      observedAt: canonicalInventoryDate,
      reservation: reservationResultSchema,
    })
    .strict(),
  z
    .object({
      evidenceKind: z.literal('CLOSED_NO_EFFECT'),
      observedAt: canonicalInventoryDate,
      proof: reserveNoEffectProofSchema,
    })
    .strict(),
]);
export type OriginalReserveDescriptor = z.infer<typeof originalReserveDescriptorSchema>;
export type ObserveReserveScopeInput = z.infer<typeof observeReserveScopeSchema>;
export type CloseReserveScopeInput = z.infer<typeof closeReserveScopeSchema>;
export type ReserveScopeObservation = z.infer<typeof reserveScopeObservationSchema>;
