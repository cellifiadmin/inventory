import { createHash } from 'node:crypto';
import { INVENTORY_OWNER_EVENT as EVENT } from '@/constants/inventoryOwnerEvents';
import type { InventoryStockTransaction } from '@/inventory/services/stockReservationShared';
import { observeReserveScopeInTransaction } from '@/inventory/services/inventoryReserveScopeService';
import {
  commitStockSchema,
  releaseStockSchema,
  reservationResultSchema,
} from '@/inventory/types/stockReservationCommands';
import { inventoryOwnerEventSchema } from '@/inventory/types/inventoryOwnerEvent';
import { workflowInputHash } from '@/inventory/services/workflows/workflowIdentity';

/** Called after a real terminal operation, under its full scope/item locks, in the same transaction. */
export const persistReservationTerminalEventInTransaction = async (
  tx: InventoryStockTransaction,
  input: { reservationOperationId: string },
) => {
  const operation = await tx.reservationOperation.findUniqueOrThrow({
    where: { id: input.reservationOperationId },
  });
  if (operation.kind !== 'COMMIT' && operation.kind !== 'RELEASE') throw new Error(EVENT.INVALID);
  const command =
    operation.kind === 'COMMIT'
      ? commitStockSchema.parse(operation.input)
      : releaseStockSchema.parse(operation.input);
  const result = reservationResultSchema.parse(operation.result);
  if (
    operation.id !== input.reservationOperationId ||
    command.operationId !== operation.id ||
    operation.checkoutId !== command.checkoutId ||
    operation.checkoutVersion !== command.version ||
    operation.inputFingerprint !==
      createHash('sha256').update(JSON.stringify(command)).digest('hex') ||
    result.checkoutId !== command.checkoutId ||
    result.version !== command.version ||
    result.lines.length !== command.lines.length ||
    new Set(command.lines.map((line) => line.reservationId)).size !== command.lines.length ||
    result.lines.some(
      (line) =>
        !command.lines.some(
          (request) =>
            request.reservationId === line.reservationId &&
            request.lineId === line.lineId &&
            line.revision === request.revision + 1,
        ),
    )
  )
    throw new Error(EVENT.INVALID);
  if (
    'scope' in command &&
    (command.scope.revision >= result.scope.revision ||
      workflowInputHash({
        ...command.scope,
        revision: result.scope.revision,
      }) !== workflowInputHash(result.scope))
  )
    throw new Error(EVENT.INVALID);
  const observation = await observeReserveScopeInTransaction(tx, {
    checkoutId: command.checkoutId,
    version: command.version,
    reserveOperationId: result.scope.reserveOperationId,
    reserveOperationInputHash: result.scope.reserveOperationInputHash,
    reserveInputHash: result.scope.reserveInputHash,
  });
  if (
    !observation ||
    observation.evidenceKind !== 'CURRENT_RESERVATION' ||
    workflowInputHash(observation.reservation.scope) !== workflowInputHash(result.scope) ||
    result.expiresAt !== observation.reservation.expiresAt ||
    result.lines.some(
      (line) =>
        !observation.reservation.lines.some(
          (current) => workflowInputHash(current) === workflowInputHash(line),
        ),
    )
  )
    throw new Error(EVENT.INVALID);
  const ids = result.lines.map((line) => line.reservationId).sort();
  const terminal =
    'paymentId' in command
      ? {
          eventKind: EVENT.COMMITTED,
          committedReservationIds: ids,
          commit: {
            reservationOperationId: operation.id,
            paymentId: command.paymentId,
            purchaseId: command.purchaseId,
            commerceSellerOrderId: command.commerceSellerOrderId,
            paymentScopeId: command.paymentScopeId,
            fence: command.fence,
          },
        }
      : {
          eventKind: EVENT.RELEASED,
          releasedReservationIds: ids,
          release: {
            reservationOperationId: operation.id,
            cause: command.cause,
            financialResolution: command.financialResolution
              ? {
                  ...command.financialResolution,
                  scopeClosedAt: new Date(command.financialResolution.scopeClosedAt).toISOString(),
                }
              : null,
          },
        };
  const payload = inventoryOwnerEventSchema.parse({
    type: EVENT.TYPE,
    schemaVersion: 1,
    producer: 'inventory',
    eventId: `${result.scope.id}:revision:${result.scope.revision}`,
    resourceType: 'checkout',
    resourceId: command.checkoutId,
    resourceVersion: command.version,
    observedAt: observation.observedAt,
    reservation: observation.reservation,
    ...terminal,
  });
  const event = await tx.inventoryOwnerEvent.create({
    data: {
      id: payload.eventId,
      scopeId: result.scope.id,
      scopeRevision: result.scope.revision,
      checkoutId: command.checkoutId,
      checkoutVersion: command.version,
      kind: payload.eventKind,
      observedAt: new Date(payload.observedAt),
      payload,
      payloadHash: workflowInputHash(payload),
    },
  });
  await tx.inventoryOwnerEventOutbox.create({ data: { eventId: event.id } });
  return event;
};
