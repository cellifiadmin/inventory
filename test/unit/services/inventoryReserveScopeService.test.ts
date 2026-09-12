import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import createError from 'http-errors';
import { commandEnvelope, rehashCommand } from '../../helpers/inventoryWorkflowFixtures';
import { reservationRecord } from '../../helpers/reservationFixtures';
import { workflowInputHash } from '@/inventory/services/workflows/workflowIdentity';
import type {
  ReserveScopeRecord,
  InventoryStockTransaction,
} from '@/inventory/services/stockReservationShared';
import type { OriginalReserveDescriptor } from '@/inventory/types/inventoryReserveScope';
const now = new Date('2030-01-01T00:00:00.000Z');
let scope: ReserveScopeRecord | null;
const snapshot = () =>
  scope ? { ...scope, lines: scope.lines.map((line) => ({ ...line })) } : null;
const mockReserve = jest.fn<(...args: unknown[]) => Promise<any>>();
jest.mock('@/inventory/services/stockReservationService', () => ({
  reserveStock: (...args: unknown[]) => mockReserve(...args),
}));
jest.mock('@/lib/prismaInventory', () => ({ __esModule: true, default: {} }));
import {
  resolveReserveCommandInTransaction,
  observeReserveScopeInTransaction,
  closeReserveScopeInTransaction,
} from '@/inventory/services/inventoryReserveScopeService';
import {
  reservationResult,
  reservationScopeIdentity,
} from '@/inventory/services/stockReservationShared';
const original = (): OriginalReserveDescriptor => {
  const event = rehashCommand({
    ...commandEnvelope('INVENTORY_RESERVE', {
      checkoutId: 'checkout',
      version: 1,
      expiresAt: '2030-01-01T00:15:00.000Z',
      lines: [{ lineId: 'line', accountId: 'seller', sourceInvId: 'item', quantity: 1 }],
    }),
    deadlineAt: '2030-01-01T00:20:00.000Z',
  });
  const { eventId: _eventId, ...descriptor } = event;
  return descriptor as OriginalReserveDescriptor;
};
const rehash = (value: OriginalReserveDescriptor) => {
  const event = rehashCommand({ ...value, eventId: 'event' });
  const { eventId: _eventId, ...descriptor } = event;
  return descriptor as OriginalReserveDescriptor;
};
const makeTx = () => ({
  inventoryReserveScope: {
    findUnique: jest
      .fn<(...args: any[]) => Promise<any>>()
      .mockImplementation(async () => snapshot()),
    create: jest.fn(async ({ data }: any) => {
      scope = {
        ...data,
        id: 'reserve-scope',
        revision: 0,
        protectedRevision: null,
        state: 'CLAIMED',
        createdAt: now,
        updatedAt: now,
        noEffectClosure: null,
        lines: data.lines.create.map((line: any) => ({
          ...line,
          id: 'scope-line',
          scopeId: 'reserve-scope',
          checkoutId: 'checkout',
          checkoutVersion: 1,
          reservation: null,
        })),
      };
      return snapshot();
    }),
    update: jest.fn(async ({ data }: any) => {
      scope = { ...scope!, ...data };
      return snapshot();
    }),
  },
  inventoryCommand: {
    findUnique: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(null),
  },
  inventoryReserveNoEffectClosure: {
    create: jest.fn(async ({ data }: any) => {
      scope!.noEffectClosure = data;
      return data;
    }),
  },
  $queryRaw: jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.join('').includes('clock_timestamp') ? [{ now }] : [{ id: values[0] }],
  ),
  $executeRaw: jest.fn<(...args: any[]) => Promise<number>>().mockResolvedValue(0),
});
let tx = makeTx();
let descriptor = original();
const transaction = () => tx as unknown as InventoryStockTransaction;
const reserve = () => resolveReserveCommandInTransaction(transaction(), descriptor);
const observe = () =>
  observeReserveScopeInTransaction(transaction(), {
    checkoutId: 'checkout',
    version: 1,
    reserveOperationId: descriptor.operationId,
    reserveOperationInputHash: descriptor.operationInputHash,
    reserveInputHash: workflowInputHash(descriptor.input),
  });
const close = () =>
  closeReserveScopeInTransaction(
    transaction(),
    { checkoutId: 'checkout', version: 1, originalReserve: descriptor, reason: 'CANCELLED' },
    'close-command',
  );
beforeEach(() => {
  scope = null;
  tx = makeTx();
  descriptor = original();
  mockReserve.mockReset().mockImplementation(async () => {
    scope!.revision = 1;
    scope!.lines[0].reservation = reservationRecord();
    return {
      ...reservationResult('checkout', 1, [reservationRecord()]),
      scope: reservationScopeIdentity(scope!),
    };
  });
});
describe('one bound reserve scope', () => {
  it('binds original immutable requested lines and accepts exactly one domain result', async () => {
    const result = await reserve();
    expect(result).toMatchObject({ outcome: 'SUCCEEDED', result: { scope: { revision: 1 } } });
    expect(scope).toMatchObject({
      state: 'RESERVED',
      reserveOperationId: descriptor.operationId,
      reserveInputHash: workflowInputHash(descriptor.input),
    });
    expect(mockReserve).toHaveBeenCalledWith(
      { ...descriptor.input, operationId: descriptor.operationId },
      transaction(),
    );
  });
  it('replays accepted domain evidence without replacing original expiry or scope revision', async () => {
    const first = await reserve();
    mockReserve.mockResolvedValueOnce(first.result);
    expect(await reserve()).toEqual(first);
    expect(tx.inventoryReserveScope.create).toHaveBeenCalledTimes(1);
  });
  it.each(['originalDescriptorHash', 'reserveOperationId'] as const)(
    'rejects changed existing scope binding %s',
    async (key) => {
      await reserve();
      scope![key] = 'changed';
      await expect(reserve()).rejects.toThrow('Reserve scope identity conflict');
    },
  );
  it('rejects reuse of the original operation under another checkout scope', async () => {
    tx.inventoryReserveScope.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'elsewhere' });
    await expect(reserve()).rejects.toThrow('Reserve scope identity conflict');
    expect(tx.inventoryReserveScope.create).not.toHaveBeenCalled();
  });
  it('verifies an already received original command before binding its scope', async () => {
    tx.inventoryCommand.findUnique.mockResolvedValueOnce({ envelopeHash: 'wrong' });
    await expect(reserve()).rejects.toThrow('Reserve scope identity conflict');
    tx.inventoryCommand.findUnique.mockResolvedValueOnce({
      envelopeHash: workflowInputHash(descriptor),
    });
    expect(await reserve()).toMatchObject({ outcome: 'SUCCEEDED' });
  });
  it('keeps an unexplained committed CLAIMED scope unknown', async () => {
    await reserve();
    scope!.state = 'CLAIMED';
    await expect(reserve()).rejects.toThrow('INVENTORY_RESERVE_EVIDENCE_INCONSISTENT');
  });
  it.each(['deadline', 'expiry'] as const)(
    'closes a never-applied expired %s using the database clock',
    async (field) => {
      descriptor = rehash({
        ...descriptor,
        ...(field === 'deadline'
          ? { deadlineAt: now.toISOString() }
          : { input: { ...descriptor.input, expiresAt: now.toISOString() } }),
      });
      expect(await reserve()).toMatchObject({
        outcome: 'FAILED',
        result: {
          noEffect: {
            closure: {
              reason: field === 'deadline' ? 'RESERVE_DEADLINE_EXPIRED' : 'RESERVE_EXPIRED',
            },
          },
        },
      });
      expect(mockReserve).not.toHaveBeenCalled();
    },
  );
  it.each([400, 403, 404, 409, 422])(
    'records zero-effect closure after definitive all-or-nothing failure %i',
    async (code) => {
      mockReserve.mockRejectedValue(createError(code, 'safe-domain-rejection'));
      expect(await reserve()).toMatchObject({
        outcome: 'FAILED',
        result: { noEffect: { closure: { reason: 'RESERVE_REJECTED' } } },
      });
      expect(tx.$executeRaw.mock.calls.map(([sql]) => String(sql))).toContain(
        'ROLLBACK TO SAVEPOINT inventory_reserve_effects',
      );
    },
  );
  it('identifies expiry reached while the domain was obtaining its stock locks', async () => {
    mockReserve.mockRejectedValue(createError(409, 'Reservation expiry has elapsed'));
    expect(await reserve()).toMatchObject({
      result: { noEffect: { closure: { reason: 'RESERVE_EXPIRED' } } },
    });
  });
  it.each([new Error('database disconnected'), createError(503), 'untyped failure'])(
    'does not infer zero effects from infrastructure uncertainty %p',
    async (error) => {
      mockReserve.mockRejectedValue(error);
      await expect(reserve()).rejects.toBe(error);
      expect(tx.inventoryReserveNoEffectClosure.create).not.toHaveBeenCalled();
    },
  );
});
describe('close and current observation authority', () => {
  it('returns null on absence without fabricating a scope or original command receipt', async () => {
    expect(await observe()).toBeNull();
    expect(tx.inventoryReserveScope.create).not.toHaveBeenCalled();
  });
  it('closes an unseen original, replays its proof, and returns it on late reserve and observation', async () => {
    const closed = await close();
    expect(closed).toMatchObject({
      evidenceKind: 'CLOSED_NO_EFFECT',
      proof: { closure: { authorizingOperationId: 'close-command' } },
    });
    expect(await close()).toEqual(closed);
    expect(await observe()).toEqual(closed);
    expect(await reserve()).toMatchObject({
      outcome: 'FAILED',
      result: { noEffect: (closed as any).proof },
    });
    expect(mockReserve).not.toHaveBeenCalled();
    expect(tx.inventoryReserveNoEffectClosure.create).toHaveBeenCalledTimes(1);
  });
  it('timestamps a newly closed scope after its persisted closure with an advancing database clock', async () => {
    let clockReads = 0;
    tx.$queryRaw.mockImplementation(async (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.join('').includes('clock_timestamp')
        ? [{ now: new Date(now.getTime() + clockReads++ * 10) }]
        : [{ id: values[0] }],
    );
    const closed = await close();
    if (closed.evidenceKind !== 'CLOSED_NO_EFFECT') throw new Error('fixture');
    // Commerce rejects no-effect observations that precede the closure being observed.
    expect(new Date(closed.observedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(closed.proof.closure.closedAt).getTime(),
    );
    expect(closed.proof.closure.closedAt).toBe(scope!.noEffectClosure!.closedAt.toISOString());
    expect(tx.inventoryReserveNoEffectClosure.create).toHaveBeenCalledTimes(1);
  });
  it('observes the full reserved set under item locks and refuses to claim it had no effects', async () => {
    await reserve();
    expect(await close()).toMatchObject({
      evidenceKind: 'CURRENT_RESERVATION',
      reservation: { scope: { revision: 1 } },
    });
    expect(await observe()).toMatchObject({ evidenceKind: 'CURRENT_RESERVATION' });
    expect(tx.inventoryReserveNoEffectClosure.create).not.toHaveBeenCalled();
    expect(tx.$queryRaw.mock.calls.some(([sql]) => String(sql).includes('FROM items'))).toBe(true);
  });
  it.each(['reserveOperationId', 'reserveOperationInputHash', 'reserveInputHash'] as const)(
    'rejects observation with mismatched %s',
    async (key) => {
      await reserve();
      scope![key] = 'changed';
      await expect(observe()).rejects.toThrow('Reserve scope identity conflict');
    },
  );
  it.each(['claimed', 'empty', 'missingLine'] as const)(
    'rejects inconsistent current scope %s',
    async (change) => {
      await reserve();
      if (change === 'claimed') scope!.state = 'CLAIMED';
      if (change === 'empty') scope!.lines = [];
      if (change === 'missingLine') scope!.lines[0].reservation = null;
      await expect(observe()).rejects.toThrow('INVENTORY_RESERVE_EVIDENCE_INCONSISTENT');
    },
  );
  it.each(['missing', 'wrongState', 'missingLine'] as const)(
    'rechecks current evidence after stock locks %s',
    async (change) => {
      await reserve();
      const before = snapshot();
      if (change === 'missing') scope = null;
      if (change === 'wrongState') scope!.state = 'CLAIMED';
      if (change === 'missingLine') scope!.lines[0].reservation = null;
      tx.inventoryReserveScope.findUnique.mockResolvedValueOnce(before);
      await expect(observe()).rejects.toThrow('INVENTORY_RESERVE_EVIDENCE_INCONSISTENT');
    },
  );
  it.each(['missingClosure', 'stockEffect', 'hash'] as const)(
    'rejects corrupt closed no-effect evidence %s',
    async (change) => {
      await close();
      if (change === 'missingClosure') scope!.noEffectClosure = null;
      if (change === 'stockEffect') scope!.lines[0].reservation = reservationRecord();
      if (change === 'hash') scope!.noEffectClosure!.evidenceHash = 'changed';
      await expect(observe()).rejects.toThrow('INVENTORY_RESERVE_EVIDENCE_INCONSISTENT');
    },
  );
  it.each([
    null,
    { state: 'RESERVED', lines: [] },
    { state: 'CLAIMED', lines: [{ reservation: {} }] },
  ])('rechecks no-effect closure eligibility before mutation %p', async (inconsistent) => {
    tx.inventoryReserveScope.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(inconsistent);
    await expect(close()).rejects.toThrow('INVENTORY_RESERVE_EVIDENCE_INCONSISTENT');
    expect(tx.inventoryReserveNoEffectClosure.create).not.toHaveBeenCalled();
  });
});
