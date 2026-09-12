import { STOCK_TRANSACTION_MAX_ATTEMPTS } from '@/constants/reservations';
import { createHash } from 'node:crypto';
import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';
import prismaInventory from '@/lib/prismaInventory';
import { Prisma, MovementDirection } from '@/lib/prismaInventoryTypes';
import {
  reservationScopeIdentitySchema,
  type ReservationScopeIdentity,
} from '@/inventory/types/reservationScopeEvidence';
import { workflowInputHash } from '@/inventory/services/workflows/workflowIdentity';
import type { ReservationOperationKind } from '.prisma/inventoryClient';
import {
  reservationResultSchema,
  type ReservationResult,
  type ReservationLineage,
} from '@/inventory/types/stockReservationCommands';

export type InventoryStockTransaction = Omit<
  typeof prismaInventory,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;
export type ReservationRecord = Prisma.StockReservationGetPayload<{
  include: { heldMovement: true };
}>;
export const withStockTransaction = async <T>(
  work: (tx: InventoryStockTransaction) => Promise<T>,
  tx?: InventoryStockTransaction,
): Promise<T> => {
  if (tx) return work(tx);
  for (let attempt = 0; ; attempt++) {
    try {
      return await prismaInventory.$transaction(work);
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== 'P2034' ||
        attempt >= STOCK_TRANSACTION_MAX_ATTEMPTS - 1
      )
        throw error;
    }
  }
};

export const lockStockItems = async (tx: InventoryStockTransaction, itemIds: number[]) => {
  for (const id of [...new Set(itemIds)].sort((a, b) => a - b)) {
    const rows = await tx.$queryRaw<Array<{ id: number }>>`
      SELECT id FROM items WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
    if (rows.length !== 1) throw createError(StatusCodes.NOT_FOUND, 'Inventory item not found');
  }
};
export const databaseNow = async (tx: InventoryStockTransaction): Promise<Date> => {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  return row.now;
};
export const stockBalance = async (
  tx: InventoryStockTransaction,
  itemId: number,
): Promise<number> => {
  const movements = await tx.movement.findMany({
    where: { itemId },
    select: { quantity: true, direction: true },
  });
  return movements.reduce(
    (sum, movement) =>
      sum + (movement.direction === MovementDirection.IN ? movement.quantity : -movement.quantity),
    0,
  );
};

export const reservationResult = (
  checkoutId: string,
  version: number,
  records: ReservationRecord[],
): Omit<ReservationResult, 'scope'> => ({
  checkoutId,
  version,
  expiresAt: new Date(
    Math.min(...records.map((record) => record.expiresAt.getTime())),
  ).toISOString(),
  lines: records.map((record) => ({
    reservationId: record.id,
    lineId: record.lineId,
    quantity: record.heldMovement.quantity,
    revision: record.revision,
    state: record.state,
    expiresAt: record.expiresAt.toISOString(),
    paymentScopeId: record.paymentScopeId,
    fence: record.fence,
    heldMovementId: record.heldMovementId,
    releasedMovementId: record.releasedMovementId,
    soldMovementId: record.soldMovementId,
  })),
});

export const reserveScopeInclude = {
  lines: {
    orderBy: { lineId: 'asc' },
    include: { reservation: { include: { heldMovement: true } } },
  },
  noEffectClosure: true,
} as const;
export type ReserveScopeRecord = Prisma.InventoryReserveScopeGetPayload<{
  include: typeof reserveScopeInclude;
}>;
export const lockReservationScope = async (
  tx: InventoryStockTransaction,
  checkoutId: string,
  version: number,
) => {
  const key = JSON.stringify(['inventory-reservation', checkoutId, version]);
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
};
export const readReservationScope = (
  tx: InventoryStockTransaction,
  checkoutId: string,
  version: number,
) =>
  tx.inventoryReserveScope.findUnique({
    where: { checkoutId_checkoutVersion: { checkoutId, checkoutVersion: version } },
    include: reserveScopeInclude,
  });
export const reservationScopeIdentity = (
  scope: Pick<
    ReserveScopeRecord,
    'id' | 'revision' | 'reserveOperationId' | 'reserveOperationInputHash' | 'reserveInputHash'
  >,
): ReservationScopeIdentity => ({
  id: scope.id,
  revision: scope.revision,
  reserveOperationId: scope.reserveOperationId,
  reserveOperationInputHash: scope.reserveOperationInputHash,
  reserveInputHash: scope.reserveInputHash,
});
export const RESERVE_EVIDENCE_INCONSISTENT = 'INVENTORY_RESERVE_EVIDENCE_INCONSISTENT';
export type ReservationEffect = { snapshot: Omit<ReservationResult, 'scope'>; changed: boolean };
export const executeReservationOperation = async (
  kind: ReservationOperationKind,
  input: { operationId: string; checkoutId: string; version: number } & Prisma.InputJsonObject,
  work: (tx: InventoryStockTransaction, scope: ReserveScopeRecord) => Promise<ReservationEffect>,
  transaction?: InventoryStockTransaction,
): Promise<ReservationResult> =>
  withStockTransaction(async (tx) => {
    await lockReservationScope(tx, input.checkoutId, input.version);
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const operationLock = JSON.stringify(['inventory-operation', input.operationId]);
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${operationLock}, 0))`;
    const previous = await tx.reservationOperation.findUnique({ where: { id: input.operationId } });
    if (previous) {
      if (previous.kind !== kind || previous.inputFingerprint !== fingerprint)
        throw createError(StatusCodes.CONFLICT, 'Reservation operation input changed');
      return reservationResultSchema.parse(previous.result);
    }
    let scope = await readReservationScope(tx, input.checkoutId, input.version);
    if (!scope) throw new Error(RESERVE_EVIDENCE_INCONSISTENT);
    if (kind === 'RESERVE') {
      const { operationId: _operationId, ...reserveInput } = input;
      if (
        scope.state !== 'CLAIMED' ||
        scope.reserveOperationId !== input.operationId ||
        scope.reserveInputHash !== workflowInputHash(reserveInput)
      ) {
        throw new Error(RESERVE_EVIDENCE_INCONSISTENT);
      }
    } else if (scope.state !== 'RESERVED') throw new Error(RESERVE_EVIDENCE_INCONSISTENT);
    if (kind === 'PROTECT') {
      const requested = input.lines as Array<{ reservationId: string }>;
      if (
        scope.protectedRevision !== null ||
        requested.length !== scope.lines.length ||
        scope.lines.some(
          (line) =>
            !line.reservation ||
            !requested.some((value) => value.reservationId === line.reservation!.id),
        )
      ) {
        throw createError(StatusCodes.CONFLICT, 'Whole reserve scope protection required');
      }
    }
    if (kind === 'COMMIT') {
      const expected = reservationScopeIdentitySchema.parse(input.scope);
      const actual = reservationScopeIdentity(scope);
      if (
        expected.revision !== scope.protectedRevision ||
        expected.id !== actual.id ||
        expected.reserveOperationId !== actual.reserveOperationId ||
        expected.reserveOperationInputHash !== actual.reserveOperationInputHash ||
        expected.reserveInputHash !== actual.reserveInputHash
      )
        throw createError(StatusCodes.CONFLICT, 'Protected reserve scope mismatch');
    }
    const effect = await work(tx, scope);
    if (effect.changed)
      scope = await tx.inventoryReserveScope.update({
        where: { id: scope.id, revision: scope.revision },
        data: {
          revision: { increment: 1 },
          ...(kind === 'PROTECT' ? { protectedRevision: scope.revision + 1 } : {}),
        },
        include: reserveScopeInclude,
      });
    const result = reservationResultSchema.parse({
      ...effect.snapshot,
      scope: reservationScopeIdentity(scope),
    });
    await tx.reservationOperation.create({
      data: {
        id: input.operationId,
        kind,
        checkoutId: input.checkoutId,
        checkoutVersion: input.version,
        inputFingerprint: fingerprint,
        input,
        result,
      },
    });
    return result;
  }, transaction);

export const loadReservationLines = async (
  tx: InventoryStockTransaction,
  input: { checkoutId: string; version: number; lines: ReservationLineage[] },
): Promise<ReservationRecord[]> => {
  const ids = input.lines.map((line) => line.reservationId);
  if (new Set(ids).size !== ids.length)
    throw createError(StatusCodes.BAD_REQUEST, 'Duplicate reservation identity');
  const initial = await tx.stockReservation.findMany({
    where: { id: { in: ids } },
    select: { itemId: true },
  });
  await lockStockItems(
    tx,
    initial.map((record) => record.itemId),
  );
  const records = await tx.stockReservation.findMany({
    where: { id: { in: ids } },
    include: { heldMovement: true },
  });
  return input.lines.map((line) => {
    const record = records.find((value) => value.id === line.reservationId);
    if (
      !record ||
      record.checkoutId !== input.checkoutId ||
      record.checkoutVersion !== input.version ||
      record.lineId !== line.lineId
    ) {
      throw createError(StatusCodes.CONFLICT, 'Reservation lineage invalid');
    }
    if (record.revision !== line.revision)
      throw createError(StatusCodes.CONFLICT, 'Reservation revision stale');
    return record;
  });
};
export const updateReservation = (
  tx: InventoryStockTransaction,
  record: ReservationRecord,
  data: Prisma.StockReservationUncheckedUpdateInput,
) =>
  tx.stockReservation.update({
    where: { id: record.id, revision: record.revision },
    data: { ...data, revision: { increment: 1 } },
    include: { heldMovement: true },
  });
