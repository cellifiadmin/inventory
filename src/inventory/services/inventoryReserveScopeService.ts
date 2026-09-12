import { randomUUID } from 'node:crypto';
import createError, { isHttpError } from 'http-errors';
import { StatusCodes } from 'http-status-codes';
import {
  originalReserveDescriptorSchema,
  observeReserveScopeSchema,
  closeReserveScopeSchema,
  type OriginalReserveDescriptor,
  type ReserveScopeObservation,
} from '@/inventory/types/inventoryReserveScope';
import {
  reserveNoEffectProofSchema,
  type ReserveNoEffectProof,
} from '@/inventory/types/reservationScopeEvidence';
import { reserveStock } from '@/inventory/services/stockReservationService';
import { workflowInputHash } from '@/inventory/services/workflows/workflowIdentity';
import {
  databaseNow,
  lockReservationScope,
  lockStockItems,
  readReservationScope,
  reserveScopeInclude,
  reservationScopeIdentity,
  reservationResult,
  RESERVE_EVIDENCE_INCONSISTENT,
  type InventoryStockTransaction,
  type ReserveScopeRecord,
} from '@/inventory/services/stockReservationShared';

const conflict = () => createError(StatusCodes.CONFLICT, 'Reserve scope identity conflict');
const inconsistent = () => new Error(RESERVE_EVIDENCE_INCONSISTENT);
const ensureScope = async (tx: InventoryStockTransaction, original: OriginalReserveDescriptor) => {
  await lockReservationScope(tx, original.input.checkoutId, original.input.version);
  const descriptorHash = workflowInputHash(original);
  const existing = await readReservationScope(
    tx,
    original.input.checkoutId,
    original.input.version,
  );
  if (existing) {
    if (
      existing.originalDescriptorHash !== descriptorHash ||
      existing.reserveOperationId !== original.operationId
    )
      throw conflict();
    return { scope: existing, created: false };
  }
  const boundElsewhere = await tx.inventoryReserveScope.findUnique({
    where: { reserveOperationId: original.operationId },
  });
  if (boundElsewhere) throw conflict();
  const accepted = await tx.inventoryCommand.findUnique({
    where: { operationId: original.operationId },
  });
  if (accepted && accepted.envelopeHash !== descriptorHash) throw conflict();
  const scope = await tx.inventoryReserveScope.create({
    data: {
      checkoutId: original.input.checkoutId,
      checkoutVersion: original.input.version,
      reserveOperationId: original.operationId,
      reserveOperationInputHash: original.operationInputHash,
      reserveInputHash: workflowInputHash(original.input),
      originalDescriptorHash: descriptorHash,
      originalDescriptor: original,
      expiresAt: new Date(original.input.expiresAt),
      lines: { create: original.input.lines },
    },
    include: reserveScopeInclude,
  });
  return { scope, created: true };
};
const proofFromScope = (scope: ReserveScopeRecord): ReserveNoEffectProof => {
  const closure = scope.noEffectClosure;
  if (
    scope.state !== 'CLOSED_NO_EFFECT' ||
    !closure ||
    scope.lines.some((line) => line.reservation !== null)
  )
    throw inconsistent();
  const proof = reserveNoEffectProofSchema.parse({
    kind: 'RESERVE_SCOPE_CLOSED_NO_EFFECT',
    scope: reservationScopeIdentity(scope),
    checkoutId: scope.checkoutId,
    version: scope.checkoutVersion,
    expiresAt: scope.expiresAt.toISOString(),
    closure: {
      id: closure.id,
      authorizingOperationId: closure.authorizingOperationId,
      reason: closure.reason,
      closedAt: closure.closedAt.toISOString(),
    },
    lines: scope.lines.map(({ lineId, accountId, sourceInvId, quantity }) => ({
      lineId,
      accountId,
      sourceInvId,
      quantity,
    })),
  });
  if (closure.evidenceHash !== workflowInputHash(proof)) throw inconsistent();
  return proof;
};
const closeEmptyScope = async (
  tx: InventoryStockTransaction,
  scope: ReserveScopeRecord,
  authorizingOperationId: string,
  reason: ReserveNoEffectProof['closure']['reason'],
) => {
  const current = await readReservationScope(tx, scope.checkoutId, scope.checkoutVersion);
  if (
    !current ||
    current.state !== 'CLAIMED' ||
    current.lines.some((line) => line.reservation !== null)
  )
    throw inconsistent();
  const closedAt = await databaseNow(tx),
    id = randomUUID();
  const updated = await tx.inventoryReserveScope.update({
    where: { id: scope.id, state: 'CLAIMED', revision: 0 },
    data: { state: 'CLOSED_NO_EFFECT', revision: 1 },
    include: reserveScopeInclude,
  });
  const proof = reserveNoEffectProofSchema.parse({
    kind: 'RESERVE_SCOPE_CLOSED_NO_EFFECT',
    scope: reservationScopeIdentity(updated),
    checkoutId: scope.checkoutId,
    version: scope.checkoutVersion,
    expiresAt: scope.expiresAt.toISOString(),
    closure: { id, authorizingOperationId, reason, closedAt: closedAt.toISOString() },
    lines: updated.lines.map(({ lineId, accountId, sourceInvId, quantity }) => ({
      lineId,
      accountId,
      sourceInvId,
      quantity,
    })),
  });
  await tx.inventoryReserveNoEffectClosure.create({
    data: {
      id,
      scopeId: scope.id,
      authorizingOperationId,
      reason,
      closedAt,
      evidenceHash: workflowInputHash(proof),
    },
  });
  return proof;
};
const currentEvidence = async (
  tx: InventoryStockTransaction,
  scope: ReserveScopeRecord,
): Promise<ReserveScopeObservation> => {
  if (scope.state === 'CLOSED_NO_EFFECT')
    return {
      evidenceKind: 'CLOSED_NO_EFFECT',
      observedAt: (await databaseNow(tx)).toISOString(),
      proof: proofFromScope(scope),
    };
  if (
    scope.state !== 'RESERVED' ||
    !scope.lines.length ||
    scope.lines.some((line) => !line.reservation)
  )
    throw inconsistent();
  await lockStockItems(
    tx,
    scope.lines.map((line) => line.reservation!.itemId),
  );
  const current = await readReservationScope(tx, scope.checkoutId, scope.checkoutVersion);
  if (!current || current.state !== 'RESERVED' || current.lines.some((line) => !line.reservation))
    throw inconsistent();
  return {
    evidenceKind: 'CURRENT_RESERVATION',
    observedAt: (await databaseNow(tx)).toISOString(),
    reservation: {
      ...reservationResult(
        scope.checkoutId,
        scope.checkoutVersion,
        current.lines.map((line) => line.reservation!),
      ),
      scope: reservationScopeIdentity(current),
    },
  };
};
export const resolveReserveCommandInTransaction = async (
  tx: InventoryStockTransaction,
  raw: unknown,
) => {
  const original = originalReserveDescriptorSchema.parse(raw);
  const { scope, created } = await ensureScope(tx, original);
  if (scope.state === 'CLOSED_NO_EFFECT')
    return {
      outcome: 'FAILED' as const,
      result: {
        errorCode: 'INVENTORY_RESERVE_SCOPE_CLOSED',
        recoveryRequired: false as const,
        noEffect: proofFromScope(scope),
      },
    };
  if (!created && scope.state === 'CLAIMED') throw inconsistent();
  const now = await databaseNow(tx);
  const reason =
    new Date(original.deadlineAt) <= now
      ? 'RESERVE_DEADLINE_EXPIRED'
      : scope.expiresAt <= now
        ? 'RESERVE_EXPIRED'
        : null;
  if (created && reason)
    return {
      outcome: 'FAILED' as const,
      result: {
        errorCode:
          reason === 'RESERVE_DEADLINE_EXPIRED'
            ? 'INVENTORY_RESERVE_DEADLINE_EXPIRED'
            : 'INVENTORY_RESERVATION_REJECTED',
        recoveryRequired: false as const,
        noEffect: await closeEmptyScope(tx, scope, original.operationId, reason),
      },
    };
  await tx.$executeRaw`SAVEPOINT inventory_reserve_effects`;
  try {
    const result = await reserveStock({ ...original.input, operationId: original.operationId }, tx);
    await tx.inventoryReserveScope.update({ where: { id: scope.id }, data: { state: 'RESERVED' } });
    await tx.$executeRaw`RELEASE SAVEPOINT inventory_reserve_effects`;
    return { outcome: 'SUCCEEDED' as const, result };
  } catch (error) {
    if (!isHttpError(error) || ![400, 403, 404, 409, 422].includes(error.statusCode)) throw error;
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT inventory_reserve_effects`;
    await tx.$executeRaw`RELEASE SAVEPOINT inventory_reserve_effects`;
    return {
      outcome: 'FAILED' as const,
      result: {
        errorCode: 'INVENTORY_RESERVATION_REJECTED',
        recoveryRequired: false as const,
        noEffect: await closeEmptyScope(
          tx,
          scope,
          original.operationId,
          error.message === 'Reservation expiry has elapsed'
            ? 'RESERVE_EXPIRED'
            : 'RESERVE_REJECTED',
        ),
      },
    };
  }
};
export const observeReserveScopeInTransaction = async (
  tx: InventoryStockTransaction,
  raw: unknown,
) => {
  const input = observeReserveScopeSchema.parse(raw);
  await lockReservationScope(tx, input.checkoutId, input.version);
  const scope = await readReservationScope(tx, input.checkoutId, input.version);
  if (!scope) return null;
  if (
    scope.reserveOperationId !== input.reserveOperationId ||
    scope.reserveOperationInputHash !== input.reserveOperationInputHash ||
    scope.reserveInputHash !== input.reserveInputHash
  )
    throw conflict();
  return currentEvidence(tx, scope);
};
export const closeReserveScopeInTransaction = async (
  tx: InventoryStockTransaction,
  raw: unknown,
  authorizingOperationId: string,
): Promise<ReserveScopeObservation> => {
  const input = closeReserveScopeSchema.parse(raw);
  const { scope, created } = await ensureScope(tx, input.originalReserve);
  if (created) {
    const proof = await closeEmptyScope(tx, scope, authorizingOperationId, 'CANCELLED');
    return {
      evidenceKind: 'CLOSED_NO_EFFECT',
      observedAt: (await databaseNow(tx)).toISOString(),
      proof,
    };
  }
  return currentEvidence(tx, scope);
};
