import { describe, expect, it } from '@jest/globals';
import { reserveStockSchema, protectReservationsSchema, commitStockSchema, releaseStockSchema } from '@/inventory/types/stockReservationCommands';

const scope = { operationId: 'op', checkoutId: 'checkout', version: 1 };
const line = { reservationId: 'reservation', lineId: 'line', revision: 0 };
describe('canonical reservation command validation', () => {
  it('requires an operation identity and rejects missing or invented lineage defaults', () => {
    expect(reserveStockSchema.safeParse({ checkoutId: 'checkout', version: 1, lines: [] }).success).toBe(false);
    expect(commitStockSchema.safeParse({ ...scope, lines: [{ lineId: 'line' }] }).success).toBe(false);
  });
  it('rejects duplicate request lines before any stock processing', () => {
    const stockLine = { lineId: 'line', accountId: 'seller', sourceInvId: 'item', quantity: 1 };
    expect(() => reserveStockSchema.parse({ ...scope, lines: [stockLine, stockLine] })).toThrow('Duplicate stock line identity');
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
