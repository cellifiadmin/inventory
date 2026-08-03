import { z } from 'zod';

import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';

import prismaInventory from '@/lib/prismaInventory';
import type { Prisma } from '@/lib/prismaInventoryTypes';
import { MovementDirection, MovementReason } from '@/lib/prismaInventoryTypes';

export const reserveStockSchema = z.object({
  checkoutId: z.string().trim().min(1),
  version: z.number().int().positive(),
  lines: z
    .array(
      z.object({
        lineId: z.string().trim().min(1),
        accountId: z.string().trim().min(1),
        sourceInvId: z.string().trim().min(1),
        quantity: z.number().int().positive(),
      }),
    )
    .min(1),
});

export const commitStockSchema = z.object({
  checkoutId: z.string().trim().min(1),
  version: z.number().int().positive(),
  lines: z
    .array(
      z.object({
        lineId: z.string().trim().min(1),
      }),
    )
    .min(1),
});

export const stockReleaseCauseSchema = z.enum(['payment_failed', 'cancelled', 'expired']);

export const releaseStockSchema = z.object({
  checkoutId: z.string().trim().min(1),
  version: z.number().int().positive(),
  cause: stockReleaseCauseSchema,
  lines: z
    .array(
      z.object({
        lineId: z.string().trim().min(1),
      }),
    )
    .min(1),
});

export type ReserveStockInput = z.infer<typeof reserveStockSchema>;
export type CommitStockInput = z.infer<typeof commitStockSchema>;
export type ReleaseStockInput = z.infer<typeof releaseStockSchema>;
export type StockReleaseCause = z.infer<typeof stockReleaseCauseSchema>;

export type MovementMetadataRecord = Record<string, unknown>;

export type MovementRecord = {
  id: number;
  itemId: number;
  quantity: number;
  direction: MovementDirection;
  reason: MovementReason;
  metadata: Prisma.JsonValue | null;
  createdAt?: Date;
};

export type InventoryStockTransaction = {
  item: typeof prismaInventory.item;
  movement: typeof prismaInventory.movement;
};

export const DEFAULT_STOCK_RESERVATION_TIMEOUT_MINUTES = 15;

export const resolveStockReservationTimeoutMinutes = (): number => {
  const rawValue = process.env.STOCK_RESERVATION_TIMEOUT_MINUTES?.trim();
  if (!rawValue) {
    return DEFAULT_STOCK_RESERVATION_TIMEOUT_MINUTES;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_STOCK_RESERVATION_TIMEOUT_MINUTES;
  }

  return parsed;
};

export const toMovementMetadataRecord = (
  value: Prisma.JsonValue | null | undefined,
): MovementMetadataRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as MovementMetadataRecord;
};

export const getMetadataString = (
  metadata: Prisma.JsonValue | null | undefined,
  key: string,
): string | null => {
  const value = toMovementMetadataRecord(metadata)[key];
  return typeof value === 'string' && value.trim() ? value : null;
};

export const getMetadataNumber = (
  metadata: Prisma.JsonValue | null | undefined,
  key: string,
): number | null => {
  const value = toMovementMetadataRecord(metadata)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

export const getMetadataDate = (
  metadata: Prisma.JsonValue | null | undefined,
  key: string,
): Date | null => {
  const value = getMetadataString(metadata, key);
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export const buildLineMetadataFilter = (input: {
  checkoutId: string;
  version: number;
  lineId: string;
}): Prisma.MovementWhereInput[] => [
  { metadata: { path: ['checkoutId'], equals: input.checkoutId } },
  { metadata: { path: ['version'], equals: input.version } },
  { metadata: { path: ['lineId'], equals: input.lineId } },
];

export const buildReservedMovementIdFilter = (
  reservedMovementId: number,
): Prisma.MovementWhereInput => ({
  metadata: { path: ['reservedMovementId'], equals: reservedMovementId },
});

export const isReservationActive = (input: {
  reservedMovementId: number;
  releaseMovements: MovementRecord[];
  soldMovements: MovementRecord[];
}): boolean =>
  !input.releaseMovements.some(
    (movement) => getMetadataNumber(movement.metadata, 'reservedMovementId') === input.reservedMovementId,
  ) &&
  !input.soldMovements.some(
    (movement) => getMetadataNumber(movement.metadata, 'reservedMovementId') === input.reservedMovementId,
  );

export const calculateMovementBalance = (movements: MovementRecord[]): number =>
  movements.reduce((total, movement) => {
    if (movement.direction === MovementDirection.IN) {
      return total + movement.quantity;
    }

    return total - movement.quantity;
  }, 0);

export const assertPositiveAvailableUnits = (
  availableUnits: number,
  requestedQuantity: number,
  sourceInvId: string,
): void => {
  if (availableUnits < requestedQuantity) {
    throw createError(
      StatusCodes.CONFLICT,
      `Insufficient inventory available for ${sourceInvId}`,
    );
  }
};

export const assertLineNotCommitted = (
  soldMovements: MovementRecord[],
  lineId: string,
): void => {
  if (soldMovements.length > 0) {
    throw createError(
      StatusCodes.CONFLICT,
      `Stock line ${lineId} is already committed`,
    );
  }
};
