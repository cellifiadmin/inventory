import { z } from 'zod';
const identity = z.string().trim().min(1).max(191);
const positive = z.number().int().positive().safe();
export const canonicalInventoryDate = z
  .string()
  .datetime({ precision: 3 })
  .refine((value) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
  }, 'Inventory date must be canonical UTC milliseconds');
export const reservationScopeIdentitySchema = z
  .object({
    id: identity,
    revision: positive,
    reserveOperationId: identity,
    reserveOperationInputHash: z.string().regex(/^[a-f0-9]{64}$/),
    reserveInputHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const requestedReservationLineSchema = z
  .object({
    lineId: identity,
    accountId: identity,
    sourceInvId: identity,
    quantity: positive,
  })
  .strict();
export const reserveNoEffectProofSchema = z
  .object({
    kind: z.literal('RESERVE_SCOPE_CLOSED_NO_EFFECT'),
    scope: reservationScopeIdentitySchema,
    checkoutId: identity,
    version: positive,
    expiresAt: canonicalInventoryDate,
    closure: z
      .object({
        id: identity,
        authorizingOperationId: identity,
        reason: z.enum([
          'RESERVE_REJECTED',
          'RESERVE_DEADLINE_EXPIRED',
          'RESERVE_EXPIRED',
          'CANCELLED',
        ]),
        closedAt: canonicalInventoryDate,
      })
      .strict(),
    lines: z
      .array(requestedReservationLineSchema)
      .min(1)
      .refine((lines) => new Set(lines.map((line) => line.lineId)).size === lines.length),
  })
  .strict();
export type ReservationScopeIdentity = z.infer<typeof reservationScopeIdentitySchema>;
export type ReserveNoEffectProof = z.infer<typeof reserveNoEffectProofSchema>;
