import { z } from 'zod';
import { ReservationState } from '@/constants/reservations';

const identity = z.string().trim().min(1);
const version = z.number().int().positive();
const revision = z.number().int().nonnegative();
const scope = { operationId: identity, checkoutId: identity, version };
const lineage = z.object({ reservationId: identity, lineId: identity, revision }).strict();
const distinctLines = <T extends { lineId: string }>(lines: T[]) =>
  new Set(lines.map(line => line.lineId)).size === lines.length;
const lines = z.array(lineage).min(1).refine(distinctLines, 'Duplicate stock line identity');

export const reserveStockSchema = z.object({
  ...scope,
  lines: z.array(z.object({ lineId: identity, accountId: identity, sourceInvId: identity,
    quantity: z.number().int().positive() }).strict()).min(1)
    .refine(distinctLines, 'Duplicate stock line identity'),
}).strict();
export const protectReservationsSchema = z.object({
  ...scope, paymentScopeId: identity, fence: version, lines,
}).strict();
export const commitStockSchema = z.object({
  ...scope, paymentScopeId: identity, fence: version, paymentId: identity,
  purchaseId: identity, commerceSellerOrderId: identity, lines,
}).strict();
export const releaseStockSchema = z.object({
  ...scope, cause: z.enum(['payment_failed', 'cancelled']), lines,
  financialResolution: z.object({
    resolutionId: identity, paymentScopeId: identity, fence: version,
    scopeClosedAt: z.string().datetime(), outcome: z.enum(['FAILED', 'CANCELLED', 'NOT_SUBMITTED']),
  }).strict().optional(),
}).strict();
export const reservationResultSchema = z.object({
  checkoutId: identity, version, expiresAt: z.string().datetime(),
  lines: z.array(z.object({
    reservationId: identity, lineId: identity, quantity: z.number().int().positive(), revision,
    state: z.nativeEnum(ReservationState),
    expiresAt: z.string().datetime(), paymentScopeId: identity.nullable(), fence: revision,
    heldMovementId: version, releasedMovementId: version.nullable(), soldMovementId: version.nullable(),
  }).strict()).min(1),
}).strict();

export type ReserveStockInput = z.infer<typeof reserveStockSchema>;
export type ProtectReservationsInput = z.infer<typeof protectReservationsSchema>;
export type CommitStockInput = z.infer<typeof commitStockSchema>;
export type ReleaseStockInput = z.infer<typeof releaseStockSchema>;
export type ReservationResult = z.infer<typeof reservationResultSchema>;
export type ReservationLineage = z.infer<typeof lineage>;
