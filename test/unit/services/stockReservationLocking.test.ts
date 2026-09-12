import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '@/lib/prismaInventoryTypes';
import {
  reservationRecord,
  reservationResponse,
  reservationScopeFixture,
} from '../../helpers/reservationFixtures';
import type { ReservationRecord } from '@/inventory/services/stockReservationShared';
import { workflowInputHash } from '@/inventory/services/workflows/workflowIdentity';
import type { ReserveScopeRecord } from '@/inventory/services/stockReservationShared';
import type { ReservationOperation } from '.prisma/inventoryClient';

const mockPersistTerminal = jest
  .fn<(...args: unknown[]) => Promise<unknown>>()
  .mockResolvedValue({});
jest.mock('@/inventory/services/workflows/inventoryTerminalOwnerEventService', () => ({
  persistReservationTerminalEventInTransaction: (...args: unknown[]) =>
    mockPersistTerminal(...args),
}));
const mockPersistExpiry = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({});
jest.mock('@/inventory/services/workflows/inventoryOwnerEventService', () => ({
  persistReservationExpiryEventInTransaction: (...args: any[]) => mockPersistExpiry(...args),
}));
const now = new Date('2030-01-01T00:00:00Z');
const asyncMock = <T>(value: T) =>
  jest.fn<(...args: unknown[]) => Promise<T>>().mockResolvedValue(value);
const makeTx = () => ({
  inventoryReserveScope: {
    findUnique: jest.fn(async () => mockScope),
    update: jest.fn(
      async ({
        data,
      }: {
        data: { revision: { increment: number }; protectedRevision?: number };
      }) => {
        mockScope = {
          ...mockScope,
          revision: mockScope.revision + data.revision.increment,
          ...(data.protectedRevision !== undefined
            ? { protectedRevision: data.protectedRevision }
            : {}),
        };
        return mockScope;
      },
    ),
  },
  item: {
    findUnique: asyncMock<{ id: number; deletedAt: Date | null } | null>({
      id: 10,
      deletedAt: null,
    }),
  },
  movement: {
    findMany: asyncMock([{ quantity: 5, direction: 'IN' }]),
    create: asyncMock({ id: 20 }),
  },
  reservationOperation: {
    findUnique: asyncMock<ReservationOperation | null>(null),
    create: asyncMock({}),
  },
  stockReservation: {
    findMany: asyncMock<ReservationRecord[]>([]),
    create: jest.fn(async ({ data }: { data: Partial<ReservationRecord> }) =>
      reservationRecord(data),
    ),
    update: jest.fn(
      async ({
        data,
      }: {
        data: Partial<Omit<ReservationRecord, 'revision'>> & {
          revision: { increment: number };
        };
      }) => reservationRecord({ ...data, revision: data.revision.increment }),
    ),
  },
  $queryRaw: jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.join('').includes('clock_timestamp')
      ? [{ now }]
      : parts.join('').includes('FROM items')
        ? [{ id: values[0] }]
        : [],
  ),
});
const makeScope = (): ReserveScopeRecord => ({
  ...reservationScopeFixture(),
  revision: 0,
  state: 'CLAIMED',
  protectedRevision: null,
  checkoutId: 'checkout',
  checkoutVersion: 1,
  originalDescriptorHash: 'descriptor',
  originalDescriptor: {},
  expiresAt: new Date('2030-01-01T00:15:00.000Z'),
  createdAt: now,
  updatedAt: now,
  noEffectClosure: null,
  lines: [
    {
      id: 'scope-line',
      scopeId: 'reserve-scope',
      checkoutId: 'checkout',
      checkoutVersion: 1,
      lineId: 'line',
      accountId: 'seller',
      sourceInvId: 'item',
      quantity: 1,
      reservation: reservationRecord(),
    },
  ],
});
let mockScope = makeScope();
let mockTx = makeTx();
const mockTransaction =
  jest.fn<(work: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => Promise<unknown>>();
const mockExpiryScan = asyncMock<ReservationRecord[]>([]);
jest.mock('@/lib/prismaInventory', () => ({
  __esModule: true,
  default: {
    $transaction: (...args: Parameters<typeof mockTransaction>) => mockTransaction(...args),
    stockReservation: {
      findMany: (...args: unknown[]) => mockExpiryScan(...args),
    },
  },
}));
import { reserveStock as reserveStockImpl } from '@/inventory/services/stockReservationService';
const reserveStock: typeof reserveStockImpl = (input, tx) => {
  const { operationId, ...body } = input;
  mockScope.reserveOperationId = operationId;
  mockScope.reserveInputHash = workflowInputHash(body);
  mockScope.lines = input.lines.map((line) => ({
    ...mockScope.lines[0],
    ...line,
  }));
  return reserveStockImpl(input, tx);
};
import { protectReservations } from '@/inventory/services/reservationProtectionService';
import { commitStock } from '@/inventory/services/stockCommitService';
import { releaseStock } from '@/inventory/services/stockReleaseService';
import { expireStockReservations } from '@/inventory/services/stockReservationExpiryService';
import {
  databaseNow,
  reservationResult,
  withStockTransaction,
} from '@/inventory/services/stockReservationShared';

const line = {
  lineId: 'line',
  accountId: 'seller',
  sourceInvId: 'item',
  quantity: 1,
};
const input = {
  operationId: 'reserve',
  checkoutId: 'checkout',
  version: 1,
  expiresAt: '2030-01-01T00:15:00.000Z',
  lines: [line],
};
const lineage = [{ reservationId: 'reservation', lineId: 'line', revision: 0 }];
const protection = {
  operationId: 'protect',
  checkoutId: 'checkout',
  version: 1,
  paymentScopeId: 'scope',
  fence: 1,
  lines: lineage,
};
const commit = {
  scope: reservationScopeFixture(2),
  ...protection,
  operationId: 'commit',
  paymentId: 'payment',
  purchaseId: 'purchase',
  commerceSellerOrderId: 'order',
};
const release = {
  operationId: 'release',
  checkoutId: 'checkout',
  version: 1,
  lines: lineage,
  cause: 'cancelled' as const,
};
const locked = () =>
  reservationRecord({
    state: 'PAYMENT_LOCKED',
    paymentScopeId: 'scope',
    fence: 1,
  });
const resolution = {
  resolutionId: 'resolution',
  paymentScopeId: 'scope',
  fence: 2,
  scopeClosedAt: now.toISOString(),
  outcome: 'FAILED' as const,
};

beforeEach(() => {
  mockPersistTerminal.mockReset().mockResolvedValue({});
  mockPersistExpiry.mockReset().mockResolvedValue({});
  mockScope = makeScope();
  mockTx = makeTx();
  mockTransaction.mockReset().mockImplementation((work) => work(mockTx));
  mockExpiryScan.mockReset().mockResolvedValue([]);
});

describe('reservation acceptance and replay', () => {
  it('preserves the caller expiry instead of the environment duration', async () => {
    const expiresAt = '2030-01-01T00:07:12.345Z';
    const result = await reserveStock({ ...input, expiresAt } as any);
    expect(result.expiresAt).toBe(expiresAt);
    expect(result.lines.every((line) => line.expiresAt === expiresAt)).toBe(true);
  });
  it.each(['2030-01-01T00:00:00.000Z', '2029-12-31T23:59:59.999Z'])(
    'rejects elapsed incoming expiry %s without new holds',
    async (expiresAt) => {
      await expect(reserveStock({ ...input, expiresAt } as any)).rejects.toThrow(
        'Reservation expiry has elapsed',
      );
      expect(mockTx.movement.create).not.toHaveBeenCalled();
      expect(mockTx.stockReservation.create).not.toHaveBeenCalled();
      expect(mockTx.reservationOperation.create).not.toHaveBeenCalled();
    },
  );
  it('rechecks expiry after ledger reads before creating a hold', async () => {
    let clockReads = 0;
    mockTx.$queryRaw.mockImplementation(async (parts, ...values) => {
      if (parts.join('').includes('clock_timestamp'))
        return [{ now: ++clockReads === 1 ? now : new Date(input.expiresAt) }];
      return parts.join('').includes('FROM items') ? [{ id: values[0] }] : [];
    });
    await expect(reserveStock(input)).rejects.toThrow('Reservation expiry has elapsed');
    expect(mockTx.movement.create).not.toHaveBeenCalled();
    expect(mockTx.reservationOperation.create).not.toHaveBeenCalled();
  });
  it('rejects a different expiry under a new operation for the same checkout version', async () => {
    mockTx.stockReservation.findMany.mockResolvedValue([reservationRecord()]);
    await expect(
      reserveStock({
        ...input,
        operationId: 'another',
        expiresAt: '2030-01-01T01:00:00.000Z',
      } as any),
    ).rejects.toThrow('INVENTORY_RESERVE_EVIDENCE_INCONSISTENT');
    expect(mockTx.movement.create).not.toHaveBeenCalled();
  });
  it('locks each stock item in ascending order before reading the ledger', async () => {
    mockTx.item.findUnique
      .mockResolvedValueOnce({ id: 20, deletedAt: null })
      .mockResolvedValueOnce({ id: 10, deletedAt: null });
    const result = await reserveStock({
      ...input,
      lines: [line, { ...line, lineId: 'second' }],
    });
    const locks = mockTx.$queryRaw.mock.calls.filter(([parts]) =>
      parts.join('').includes('FROM items'),
    );
    expect(locks.map(([, id]) => id)).toEqual([10, 20]);
    expect(result.expiresAt).toBe('2030-01-01T00:15:00.000Z');
    expect(mockTx.movement.create).toHaveBeenCalledTimes(2);
    expect(mockTx.reservationOperation.create).toHaveBeenCalledTimes(1);
  });
  it('aggregates same-item lines before creating any hold', async () => {
    await expect(
      reserveStock({
        ...input,
        lines: [
          { ...line, quantity: 3 },
          { ...line, lineId: 'second', quantity: 3 },
        ],
      }),
    ).rejects.toThrow('Insufficient inventory available');
    expect(
      mockTx.$queryRaw.mock.calls.filter(([parts]) => parts.join('').includes('FROM items')),
    ).toHaveLength(1);
    expect(mockTx.movement.create).not.toHaveBeenCalled();
  });
  it('subtracts outbound ledger movements from availability', async () => {
    mockTx.movement.findMany.mockResolvedValue([
      { quantity: 1, direction: 'IN' },
      { quantity: 1, direction: 'OUT' },
    ]);
    await expect(reserveStock(input)).rejects.toThrow('Insufficient inventory available');
  });
  it.each([null, { id: 10, deletedAt: now }])(
    'rejects missing or deleted stock %p',
    async (item) => {
      mockTx.item.findUnique.mockResolvedValue(item);
      await expect(reserveStock(input)).rejects.toThrow('Inventory item not found for item');
    },
  );
  it('rejects an item deleted before its lock can be acquired', async () => {
    mockTx.$queryRaw.mockResolvedValue([]);
    await expect(reserveStock(input)).rejects.toThrow('Inventory item not found');
  });
  it('participates in an enclosing inbox/outbox transaction', async () => {
    await withStockTransaction((tx) => reserveStock(input, tx));
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });
  it('returns identical durable command results without reading stock again', async () => {
    const first = await reserveStock(input);
    const clockReads = mockTx.$queryRaw.mock.calls.filter(([parts]) =>
      parts.join('').includes('clock_timestamp'),
    ).length;
    const stored = mockTx.reservationOperation.create.mock.calls[0][0] as {
      data: ReservationOperation;
    };
    mockTx.reservationOperation.findUnique.mockResolvedValue(stored.data);
    // Completed operation evidence is replayed even after the current hold state/clock changes.
    mockTx.$queryRaw.mockResolvedValue([{ now: new Date('2031-01-01') }]);
    expect(await reserveStock(input)).toEqual(first);
    expect(
      mockTx.$queryRaw.mock.calls.filter(([parts]) => parts.join('').includes('clock_timestamp')),
    ).toHaveLength(clockReads);
    await expect(reserveStock({ ...input, expiresAt: '2030-01-01T00:16:00.000Z' })).rejects.toThrow(
      'Reservation operation input changed',
    );
    expect(mockTx.movement.create).toHaveBeenCalledTimes(1);
    await expect(reserveStock({ ...input, lines: [{ ...line, quantity: 2 }] })).rejects.toThrow(
      'Reservation operation input changed',
    );
    await expect(
      protectReservations({ ...protection, operationId: input.operationId }),
    ).rejects.toThrow('Reservation operation input changed');
  });
  it('rejects malformed persisted command results', async () => {
    await reserveStock(input);
    const stored = mockTx.reservationOperation.create.mock.calls[0][0] as {
      data: ReservationOperation;
    };
    mockTx.reservationOperation.findUnique.mockResolvedValue({
      ...stored.data,
      result: {},
    });
    await expect(reserveStock(input)).rejects.toThrow();
  });
  it('rejects unexplained existing stock effects instead of treating them as a fresh reserve', async () => {
    mockTx.stockReservation.findMany.mockResolvedValue([reservationRecord()]);
    await expect(reserveStock(input)).rejects.toThrow('INVENTORY_RESERVE_EVIDENCE_INCONSISTENT');
    expect(mockTx.movement.create).not.toHaveBeenCalled();
  });
  it('returns the earliest reservation expiry', () => {
    const earlier = new Date('2029-01-01');
    expect(
      reservationResult('checkout', 1, [
        reservationRecord(),
        reservationRecord({ expiresAt: earlier }),
      ]).expiresAt,
    ).toBe(earlier.toISOString());
  });
});

describe('payment protection and exact lineage', () => {
  beforeEach(() => {
    mockScope.state = 'RESERVED';
    mockScope.revision = 1;
    mockTx.stockReservation.findMany.mockResolvedValue([reservationRecord()]);
  });
  it('protects stock without writing another movement', async () => {
    const result = await protectReservations(protection);
    expect(result.lines[0]).toMatchObject({
      state: 'PAYMENT_LOCKED',
      revision: 1,
      fence: 1,
      paymentScopeId: 'scope',
    });
    expect(mockTx.movement.create).not.toHaveBeenCalled();
  });
  it.each([{ state: 'RELEASED' as const }, { expiresAt: now }, { fence: 1 }])(
    'rejects invalid protection transition %p',
    async (change) => {
      mockTx.stockReservation.findMany.mockResolvedValue([reservationRecord(change)]);
      await expect(protectReservations(protection)).rejects.toThrow(
        'Reservation cannot be payment protected',
      );
    },
  );
  it.each([{ checkoutId: 'other' }, { checkoutVersion: 2 }, { lineId: 'other' }, { revision: 1 }])(
    'rejects wrong lineage or stale revision %p',
    async (change) => {
      mockTx.stockReservation.findMany.mockResolvedValue([reservationRecord(change)]);
      await expect(protectReservations(protection)).rejects.toThrow(
        change.revision ? 'Reservation revision stale' : 'Reservation lineage invalid',
      );
    },
  );
  it('rejects missing reservations', async () => {
    mockTx.stockReservation.findMany.mockResolvedValue([]);
    await expect(protectReservations(protection)).rejects.toThrow('Reservation lineage invalid');
  });
  it('rejects a duplicate reservation ID attached to another line', async () => {
    await expect(
      protectReservations({
        ...protection,
        lines: [...lineage, { ...lineage[0], lineId: 'second' }],
      }),
    ).rejects.toThrow('Whole reserve scope protection required');
  });
});

describe('commit and release', () => {
  beforeEach(() => {
    mockScope.state = 'RESERVED';
    mockScope.revision = 2;
    mockScope.protectedRevision = 2;
    mockTx.stockReservation.findMany.mockResolvedValue([locked()]);
  });
  it('commits the protected hold through linked immutable release and sold movements', async () => {
    mockTx.movement.create.mockResolvedValueOnce({ id: 21 }).mockResolvedValueOnce({ id: 22 });
    const result = await commitStock(commit);
    expect(result.lines[0]).toMatchObject({
      state: 'COMMITTED',
      releasedMovementId: 21,
      soldMovementId: 22,
    });
    expect(mockTx.stockReservation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          paymentId: 'payment',
          purchaseId: 'purchase',
          commerceSellerOrderId: 'order',
        }),
      }),
    );
  });
  it.each([{ state: 'HELD' as const }, { paymentScopeId: 'other' }, { fence: 2 }])(
    'rejects commitment outside exact protection %p',
    async (change) => {
      mockTx.stockReservation.findMany.mockResolvedValue([
        reservationRecord({ ...locked(), ...change }),
      ]);
      await expect(commitStock(commit)).rejects.toThrow('Reservation payment protection mismatch');
    },
  );
  it('releases an ordinary hold without financial evidence', async () => {
    mockTx.stockReservation.findMany.mockResolvedValue([reservationRecord()]);
    expect((await releaseStock(release)).lines[0].state).toBe('RELEASED');
    expect(mockTx.movement.create).toHaveBeenCalledTimes(1);
  });
  it('persists verified closure and the newer fencing token when releasing protected stock', async () => {
    await releaseStock({ ...release, financialResolution: resolution });
    expect(mockTx.stockReservation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          resolutionId: 'resolution',
          scopeClosedAt: now,
          fence: 2,
          state: 'RELEASED',
        }),
      }),
    );
  });
  it.each([
    undefined,
    { ...resolution, paymentScopeId: 'other' },
    { ...resolution, fence: 1 },
    { ...resolution, scopeClosedAt: '2031-01-01T00:00:00.000Z' },
  ])('rejects unsafe protected release %p', async (financialResolution) => {
    await expect(releaseStock({ ...release, financialResolution })).rejects.toThrow(
      'Verified closed payment scope required',
    );
  });
  it('rejects terminal release without creating compensation', async () => {
    mockTx.stockReservation.findMany.mockResolvedValue([reservationRecord({ state: 'COMMITTED' })]);
    await expect(releaseStock(release)).rejects.toThrow('Reservation cannot be released');
    expect(mockTx.movement.create).not.toHaveBeenCalled();
  });
});

describe('expiry and transaction failures', () => {
  beforeEach(() => {
    mockScope.state = 'RESERVED';
    mockScope.revision = 1;
  });
  it('does nothing when the indexed scan has no ordinary expired holds', async () => {
    expect(await expireStockReservations()).toEqual({
      expiredReservationCount: 0,
      lines: [],
    });
    expect(mockExpiryScan).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { state: 'HELD', expiresAt: { lte: now } },
        take: 100,
      }),
    );
  });
  it('expires a hold and links exactly one release movement', async () => {
    const expired = reservationRecord({ expiresAt: now });
    mockExpiryScan.mockResolvedValue([expired]);
    mockTx.stockReservation.findMany.mockResolvedValue([expired]);
    const result = await expireStockReservations();
    expect(result.expiredReservationCount).toBe(1);
    expect(result.lines[0].state).toBe('EXPIRED');
    expect(mockTx.movement.create).toHaveBeenCalledTimes(1);
  });
  it('persists expiry evidence after the scope revision and domain operation in the same transaction', async () => {
    const expired = reservationRecord({ expiresAt: now });
    mockScope.lines.push({
      ...mockScope.lines[0],
      id: 'second-scope-line',
      lineId: 'second',
      reservation: reservationRecord({ itemId: 5, id: 'second' }),
    });
    mockExpiryScan.mockResolvedValue([expired]);
    mockTx.stockReservation.findMany.mockResolvedValue([expired]);
    await expireStockReservations();
    expect(mockPersistExpiry).toHaveBeenCalledWith(mockTx, {
      checkoutId: 'checkout',
      version: 1,
      scope: expect.objectContaining({ revision: 2 }),
      expiredReservationIds: ['reservation'],
    });
    expect(mockTx.reservationOperation.create.mock.invocationCallOrder[0]).toBeLessThan(
      mockPersistExpiry.mock.invocationCallOrder[0],
    );
    const locks = mockTx.$queryRaw.mock.calls
      .filter(([parts]) => parts.join('').includes('FROM items'))
      .map(([, id]) => id);
    expect(locks.slice(0, 2)).toEqual([5, 10]);
    const stored = mockTx.reservationOperation.create.mock.calls[0][0] as {
      data: ReservationOperation;
    };
    mockTx.reservationOperation.findUnique.mockResolvedValue(stored.data);
    expect((await expireStockReservations()).expiredReservationCount).toBe(0);
    expect(mockPersistExpiry).toHaveBeenCalledTimes(1);
  });
  it('fails closed if the scope is missing another requested reservation', async () => {
    mockExpiryScan.mockResolvedValue([reservationRecord({ expiresAt: now })]);
    mockScope.lines[0].reservation = null;
    await expect(expireStockReservations()).rejects.toThrow(
      'INVENTORY_RESERVE_EVIDENCE_INCONSISTENT',
    );
    expect(mockPersistExpiry).not.toHaveBeenCalled();
  });
  it('propagates event persistence failure so expiry cannot commit without notification', async () => {
    const expired = reservationRecord({ expiresAt: now });
    mockExpiryScan.mockResolvedValue([expired]);
    mockTx.stockReservation.findMany.mockResolvedValue([expired]);
    mockPersistExpiry.mockRejectedValue(new Error('event write failure'));
    await expect(expireStockReservations()).rejects.toThrow('event write failure');
  });
  it.each([{ state: 'PAYMENT_LOCKED' as const }, {}])(
    'rechecks state and time under the item lock %p',
    async (change) => {
      mockExpiryScan.mockResolvedValue([reservationRecord({ expiresAt: now })]);
      mockTx.stockReservation.findMany.mockResolvedValue([reservationRecord(change)]);
      expect((await expireStockReservations()).expiredReservationCount).toBe(0);
      expect(mockTx.movement.create).not.toHaveBeenCalled();
    },
  );
  it('skips a stale scan after a winning protection transition', async () => {
    mockExpiryScan.mockResolvedValue([reservationRecord({ expiresAt: now })]);
    mockTx.stockReservation.findMany.mockResolvedValue([reservationRecord({ revision: 1 })]);
    expect((await expireStockReservations()).expiredReservationCount).toBe(0);
  });
  it.each([new Error('database unavailable'), 'non-error rejection'])(
    'does not swallow expiry database failures %p',
    async (error) => {
      mockExpiryScan.mockResolvedValue([reservationRecord({ expiresAt: now })]);
      mockTx.stockReservation.findMany.mockRejectedValue(error);
      await expect(expireStockReservations()).rejects.toEqual(error);
    },
  );
  it('retries serialization failures within a bounded transaction budget', async () => {
    const error = new Prisma.PrismaClientKnownRequestError('retry', {
      code: 'P2034',
      clientVersion: 'test',
    });
    mockTransaction.mockRejectedValueOnce(error).mockRejectedValueOnce(error);
    expect(await withStockTransaction(databaseNow)).toEqual(now);
    expect(mockTransaction).toHaveBeenCalledTimes(3);
    mockTransaction.mockReset().mockRejectedValue(error);
    await expect(withStockTransaction(databaseNow)).rejects.toBe(error);
    expect(mockTransaction).toHaveBeenCalledTimes(3);
  });
  it('propagates non-retryable Prisma errors', async () => {
    const error = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: 'test',
    });
    mockTransaction.mockRejectedValue(error);
    await expect(withStockTransaction(databaseNow)).rejects.toBe(error);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });
});

describe('immutable scope guards across lifecycle operations', () => {
  it('rejects effects without an admitted scope and checks scope before command and stock locks', async () => {
    mockTx.inventoryReserveScope.findUnique.mockResolvedValueOnce(null as any);
    await expect(reserveStock(input)).rejects.toThrow('INVENTORY_RESERVE_EVIDENCE_INCONSISTENT');
    expect(
      mockTx.$queryRaw.mock.calls.slice(0, 2).map(([, value]) => JSON.parse(String(value))[0]),
    ).toEqual(['inventory-reservation', 'inventory-operation']);
    expect(mockTx.movement.create).not.toHaveBeenCalled();
  });
  it.each(['state', 'operation', 'hash'])(
    'rejects raw reserve outside its bound owner authority %s',
    async (change) => {
      const { operationId, ...body } = input;
      mockScope.reserveOperationId = operationId;
      mockScope.reserveInputHash = workflowInputHash(body);
      if (change === 'state') mockScope.state = 'RESERVED';
      if (change === 'operation') mockScope.reserveOperationId = 'other';
      if (change === 'hash') mockScope.reserveInputHash = 'changed';
      await expect(reserveStockImpl(input)).rejects.toThrow(
        'INVENTORY_RESERVE_EVIDENCE_INCONSISTENT',
      );
    },
  );
  it('rejects lifecycle mutations on a scope that never established reservations', async () => {
    await expect(releaseStock(release)).rejects.toThrow('INVENTORY_RESERVE_EVIDENCE_INCONSISTENT');
  });
  it.each([
    'id',
    'revision',
    'reserveOperationId',
    'reserveOperationInputHash',
    'reserveInputHash',
  ] as const)('requires exact frozen protection scope %s', async (field) => {
    mockScope.state = 'RESERVED';
    mockScope.revision = 5;
    mockScope.protectedRevision = 2;
    const expected = {
      ...commit.scope,
      [field]: field === 'revision' ? 1 : field.includes('Hash') ? 'c'.repeat(64) : 'other',
    };
    await expect(commitStock({ ...commit, scope: expected })).rejects.toThrow(
      'Protected reserve scope mismatch',
    );
    expect(mockTx.movement.create).not.toHaveBeenCalled();
  });
  it.each(['alreadyProtected', 'missing', 'different'])(
    'rejects protection outside the complete bound set %s',
    async (change) => {
      mockScope.state = 'RESERVED';
      mockScope.revision = 1;
      if (change === 'alreadyProtected') mockScope.protectedRevision = 2;
      if (change === 'missing') mockScope.lines[0].reservation = null;
      const command =
        change === 'different'
          ? {
              ...protection,
              lines: [{ ...lineage[0], reservationId: 'other' }],
            }
          : protection;
      await expect(protectReservations(command)).rejects.toThrow(
        'Whole reserve scope protection required',
      );
    },
  );
  it('rejects duplicate reservation IDs before any release effect', async () => {
    mockScope.state = 'RESERVED';
    mockScope.revision = 1;
    await expect(
      releaseStock({
        ...release,
        lines: [...lineage, { ...lineage[0], lineId: 'second' }],
      }),
    ).rejects.toThrow('Duplicate reservation identity');
  });
});

describe('terminal owner event atomic hooks', () => {
  beforeEach(() => {
    mockScope.state = 'RESERVED';
    mockScope.revision = 2;
    mockScope.protectedRevision = 2;
    mockTx.stockReservation.findMany.mockResolvedValue([locked()]);
    mockScope.lines = [
      { ...mockScope.lines[0], reservation: locked() },
      {
        ...mockScope.lines[0],
        id: 'lower-scope-line',
        lineId: 'lower',
        reservation: reservationRecord({ id: 'lower', itemId: 5 }),
      },
    ];
  });
  it.each(['COMMIT', 'RELEASE'])(
    'rejects %s when full scope stock lineage is incomplete',
    async (kind) => {
      mockScope.lines[1].reservation = null;
      await expect(
        kind === 'COMMIT'
          ? commitStock(commit)
          : releaseStock({ ...release, financialResolution: resolution }),
      ).rejects.toThrow('INVENTORY_RESERVE_EVIDENCE_INCONSISTENT');
      expect(mockTx.movement.create).not.toHaveBeenCalled();
      expect(mockPersistTerminal).not.toHaveBeenCalled();
    },
  );
  it.each(['COMMIT', 'RELEASE'])(
    'locks the full scope before subset %s writes and publishes after the operation is recorded',
    async (kind) => {
      const result =
        kind === 'COMMIT'
          ? await commitStock(commit)
          : await releaseStock({ ...release, financialResolution: resolution });
      const calls = mockTx.$queryRaw.mock.calls
        .map((args, index) => ({
          sql: args[0].join(''),
          id: args[1],
          order: mockTx.$queryRaw.mock.invocationCallOrder[index],
        }))
        .filter((x) => x.sql.includes('FROM items'));
      expect(calls.slice(0, 2).map((x) => x.id)).toEqual([5, 10]);
      expect(calls[1].order).toBeLessThan(mockTx.movement.create.mock.invocationCallOrder[0]);
      expect(mockPersistTerminal).toHaveBeenCalledWith(mockTx, {
        reservationOperationId: kind === 'COMMIT' ? 'commit' : 'release',
      });
      expect(mockTx.reservationOperation.create.mock.invocationCallOrder[0]).toBeLessThan(
        mockPersistTerminal.mock.invocationCallOrder[0],
      );
      expect(result.scope.revision).toBe(3);
    },
  );
  it('propagates terminal delivery failure so the outer stock transaction rolls back', async () => {
    mockPersistTerminal.mockRejectedValueOnce(Error('terminal outbox unavailable'));
    await expect(commitStock(commit)).rejects.toThrow('terminal outbox unavailable');
  });
});
