import { describe, expect, it } from '@jest/globals';
import { commandEnvelope } from '../../helpers/inventoryWorkflowFixtures';
import { workflowInputHash } from '@/inventory/services/workflows/workflowIdentity';
import {
  originalReserveDescriptorSchema,
  observeReserveScopeSchema,
  closeReserveScopeSchema,
} from '@/inventory/types/inventoryReserveScope';

const reserve = () => {
  const { eventId: _eventId, ...original } = commandEnvelope('INVENTORY_RESERVE', {
    checkoutId: 'checkout',
    version: 1,
    expiresAt: '2030-01-01T00:15:00.000Z',
    lines: [{ lineId: 'line', accountId: 'seller', sourceInvId: 'item', quantity: 1 }],
  });
  return original;
};
describe('immutable Inventory reserve scope contracts', () => {
  it('accepts the canonical original scope and binds every reserve input field', () => {
    const original = reserve();
    expect(originalReserveDescriptorSchema.parse(original)).toEqual(original);
    expect(
      observeReserveScopeSchema.parse({
        checkoutId: 'checkout',
        version: 1,
        reserveOperationId: original.operationId,
        reserveOperationInputHash: original.operationInputHash,
        reserveInputHash: workflowInputHash(original.input),
      }),
    ).toMatchObject({ reserveOperationId: original.operationId });
    expect(
      closeReserveScopeSchema.parse({
        checkoutId: 'checkout',
        version: 1,
        originalReserve: original,
        reason: 'CANCELLED',
      }),
    ).toMatchObject({ originalReserve: original });
  });
  it.each([
    { producer: 'fulfillment' },
    { command: 'INVENTORY_PROTECT' },
    { resourceId: 'other' },
    { resourceVersion: 2 },
    { resourceType: 'seller_order' },
    { stepKey: 'INVENTORY_OBSERVE' },
    { participantKey: 'inventory:other' },
    { operationInputHash: '0'.repeat(64) },
  ])('rejects a detached original reserve descriptor %p', (change) => {
    expect(originalReserveDescriptorSchema.safeParse({ ...reserve(), ...change }).success).toBe(
      false,
    );
  });
  it('does not accept modified expiry or requested quantity under an old hash', () => {
    const original = reserve();
    expect(
      originalReserveDescriptorSchema.safeParse({
        ...original,
        input: { ...original.input, expiresAt: '2030-01-01T00:16:00.000Z' },
      }).success,
    ).toBe(false);
  });
  it.each([{ checkoutId: 'other' }, { version: 2 }, { reason: 'TIMEOUT' }])(
    'rejects close with changed scope or unsupported authority %p',
    (change) => {
      expect(
        closeReserveScopeSchema.safeParse({
          checkoutId: 'checkout',
          version: 1,
          originalReserve: reserve(),
          reason: 'CANCELLED',
          ...change,
        }).success,
      ).toBe(false);
    },
  );
  it('rejects aliases, missing hashes, empty scopes, and fabricated original receipts', () => {
    expect(
      observeReserveScopeSchema.safeParse({
        checkoutId: 'checkout',
        version: 1,
        reserveOperationId: 'op',
      }).success,
    ).toBe(false);
    expect(
      originalReserveDescriptorSchema.safeParse({ ...reserve(), eventId: 'fabricated' }).success,
    ).toBe(false);
    expect(
      closeReserveScopeSchema.safeParse({
        checkoutId: '',
        version: 1,
        originalReserve: reserve(),
        reason: 'CANCELLED',
      }).success,
    ).toBe(false);
  });
});
