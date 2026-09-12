import { INVENTORY_OWNER_EVENT as EVENT } from '@/constants/inventoryOwnerEvents';
import { WORKFLOW_SCHEMA_VERSION } from '@/constants/inventoryWorkflows';
import { observeReserveScopeInTransaction } from '@/inventory/services/inventoryReserveScopeService';
import type { InventoryStockTransaction } from '@/inventory/services/stockReservationShared';
import type { ReservationScopeIdentity } from '@/inventory/types/reservationScopeEvidence';
import { inventoryOwnerEventSchema } from '@/inventory/types/inventoryOwnerEvent';
import { workflowInputHash } from '@/inventory/services/workflows/workflowIdentity';

/** Expiry and this immutable evidence must share the same scope/stock-locked owner transaction. */
export const persistReservationExpiryEventInTransaction = async (
  tx: InventoryStockTransaction,
  input: {
    checkoutId: string;
    version: number;
    scope: ReservationScopeIdentity;
    expiredReservationIds: string[];
  },
) => {
  const observation = await observeReserveScopeInTransaction(tx, {
    checkoutId: input.checkoutId,
    version: input.version,
    reserveOperationId: input.scope.reserveOperationId,
    reserveOperationInputHash: input.scope.reserveOperationInputHash,
    reserveInputHash: input.scope.reserveInputHash,
  });
  if (
    !observation ||
    observation.evidenceKind !== 'CURRENT_RESERVATION' ||
    observation.reservation.scope.id !== input.scope.id ||
    observation.reservation.scope.revision !== input.scope.revision
  )
    throw new Error(EVENT.INVALID);
  const payload = inventoryOwnerEventSchema.parse({
    type: EVENT.TYPE,
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    producer: 'inventory',
    eventKind: EVENT.EXPIRY,
    eventId: `${input.scope.id}:revision:${input.scope.revision}`,
    resourceType: 'checkout',
    resourceId: input.checkoutId,
    resourceVersion: input.version,
    observedAt: observation.observedAt,
    expiredReservationIds: [...input.expiredReservationIds].sort(),
    reservation: observation.reservation,
  });
  const event = await tx.inventoryOwnerEvent.create({
    data: {
      id: payload.eventId,
      scopeId: input.scope.id,
      scopeRevision: input.scope.revision,
      checkoutId: input.checkoutId,
      checkoutVersion: input.version,
      kind: payload.eventKind,
      observedAt: new Date(payload.observedAt),
      payload,
      payloadHash: workflowInputHash(payload),
    },
  });
  await tx.inventoryOwnerEventOutbox.create({ data: { eventId: event.id } });
  return event;
};
