import { describe, expect, it } from '@jest/globals';
import { reserveStockSchema, protectReservationsSchema, commitStockSchema, releaseStockSchema } from '@/inventory/types/stockReservationCommands';

const scope = { operationId: 'op', checkoutId: 'checkout', version: 1 };
const line = { reservationId: 'reservation', lineId: 'line', revision: 0 };
describe('canonical reservation command validation', () => {
  it.each([undefined, 'invalid', '2030-01-01T00:15:00Z', '2030-01-01T00:15:00.000+00:00', '2030-01-01T00:15:00.0000Z', '2030-02-30T00:15:00.000Z'])('rejects missing or noncanonical reserve expiry %s', expiresAt => {
    expect(reserveStockSchema.safeParse({ ...scope, expiresAt, lines: [{ lineId: 'line', accountId: 'seller', sourceInvId: 'item', quantity: 1 }] }).success).toBe(false);
  });
  it('requires expiry even when the rest of the reserve input is valid', () => {
    expect(reserveStockSchema.safeParse({ ...scope, lines: [{ lineId: 'line', accountId: 'seller', sourceInvId: 'item', quantity: 1 }] }).success).toBe(false);
  });
  it('requires an operation identity and rejects missing or invented lineage defaults', () => {
    expect(reserveStockSchema.safeParse({ checkoutId: 'checkout', version: 1, lines: [] }).success).toBe(false);
    expect(commitStockSchema.safeParse({ ...scope, lines: [{ lineId: 'line' }] }).success).toBe(false);
  });
  it('rejects duplicate request lines before any stock processing', () => {
    const stockLine = { lineId: 'line', accountId: 'seller', sourceInvId: 'item', quantity: 1 };
    expect(() => reserveStockSchema.parse({ ...scope, expiresAt: '2030-01-01T00:15:00.000Z', lines: [stockLine, stockLine] })).toThrow('Duplicate stock line identity');
    expect(() => protectReservationsSchema.parse({ ...scope, paymentScopeId: 'scope', fence: 1, lines: [line, line] })).toThrow('Duplicate stock line identity');
  });
  it.each(['UNKNOWN', 'TIMED_OUT', 'CAPTURED'])('rejects unsafe payment resolution %s', outcome => {
    expect(releaseStockSchema.safeParse({ ...scope, cause: 'payment_failed', lines: [line], financialResolution: {
      resolutionId: 'resolution', paymentScopeId: 'scope', fence: 2, scopeClosedAt: new Date().toISOString(), outcome,
    } }).success).toBe(false);
  });
  it('rejects unknown command fields and negative revisions', () => {
    expect(protectReservationsSchema.safeParse({ ...scope, paymentScopeId: 'scope', fence: 1, lines: [line], legacyMetadata: {} }).success).toBe(false);
    expect(protectReservationsSchema.safeParse({ ...scope, paymentScopeId: 'scope', fence: 1, lines: [{ ...line, revision: -1 }] }).success).toBe(false);
  });
});
