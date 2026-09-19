import { describe, expect, it } from '@jest/globals';
import { parseReturnRestockInput } from '@/inventory/services/returnRestockService';

describe('inspected return restock contract', () => {
  const input = () => ({ operationId: 'return:1:restock:v1', returnId: 'return-1',
    sellerOrderId: 'order-1', sellerAccountId: 'seller-1', evidenceHash: 'a'.repeat(64),
    lines: [{ sourceInvId: 'phone-1', commercePurchaseLineId: 'line-1', quantity: 1 }] });

  it('requires identity evidence and positive unique returned lines', () => {
    expect(parseReturnRestockInput(input())).toMatchObject({ returnId: 'return-1' });
  });

  it('rejects duplicate line identities', () => {
    const value = input(); value.lines.push({ ...value.lines[0] });
    expect(() => parseReturnRestockInput(value)).toThrow();
  });
});
