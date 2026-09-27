import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockLock = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue();
const mockBalance = jest.fn<(...args: unknown[]) => Promise<number>>().mockResolvedValue(5);
const mockIdentity = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ identifiers: [] });
jest.mock('@/inventory/services/stockReservationShared', () => ({
  lockStockItems: (...args: unknown[]) => mockLock(...args),
  stockBalance: (...args: unknown[]) => mockBalance(...args),
}));
jest.mock('@/inventory/services/saleIdentityService', () => ({ captureSaleIdentity: (...args: unknown[]) => mockIdentity(...args) }));
import { reserveReplacementStock, transitionReplacementStock } from '@/inventory/services/replacementStockService';

const input = () => ({ operationId: 'replacement:shipment:reserve:v1', shipmentId: 'shipment',
  entitlementId: 'entitlement', sellerOrderId: 'seller-order', sellerAccountId: 'seller',
  purchaseId: 'purchase', commerceSellerOrderId: 'commercial-order',
  commercePurchaseLineId: 'line', sourceInvId: 'item', quantity: 2 });
const hold = () => ({ id: 'hold', operationId: input().operationId, inputHash: '', state: 'HELD',
  shipmentId: 'shipment', entitlementId: 'entitlement', sellerOrderId: 'seller-order',
  sellerAccountId: 'seller', purchaseId: 'purchase', commerceSellerOrderId: 'commercial-order',
  commercePurchaseLineId: 'line', itemId: 7, heldMovementId: 8, quantity: 2, saleIdentity: { identifiers: [] } });
const tx = () => ({
  replacementStockHold: { findUnique: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(null),
    findUniqueOrThrow: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(hold()),
    create: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(hold()),
    update: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(hold()) },
  item: { findUnique: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ id: 7, deletedAt: null, status: 'ACTIVE' }),
    findUniqueOrThrow: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ sellerIdentifier: 'seller', itemCode: 'item' }) },
  stockReservation: { findMany: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue([{ soldMovement: { id: 4, direction: 'OUT', reason: 'SOLD', itemId: 7 } }]) },
  movement: { create: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValueOnce({ id: 8 }).mockResolvedValueOnce({ id: 9 }) },
});
type Tx = ReturnType<typeof tx>;
const asTx = (value: Tx) => value as never;
beforeEach(() => { mockLock.mockClear(); mockBalance.mockReset().mockResolvedValue(5); mockIdentity.mockReset().mockResolvedValue({ identifiers: [] }); });

describe('replacement stock reserve', () => {
  it('persists an exact sale-bound hold and preserves immutable replay', async () => {
    const db = tx();
    expect(await reserveReplacementStock(input(), asTx(db))).toMatchObject({ itemId: 7, heldMovementId: 8, quantity: 2 });
    expect(db.movement.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reason: 'RESERVED' }) }));
    expect(db.replacementStockHold.create).toHaveBeenCalledTimes(1);
    const stored = db.replacementStockHold.create.mock.calls[0][0] as { data: { inputHash: string } };
    db.replacementStockHold.findUnique.mockResolvedValue({ ...hold(), inputHash: stored.data.inputHash });
    expect(await reserveReplacementStock(input(), asTx(db))).toMatchObject({ heldMovementId: 8 });
    expect(db.replacementStockHold.create).toHaveBeenCalledTimes(1);
    db.replacementStockHold.findUnique.mockResolvedValue({ ...hold(), inputHash: 'different' });
    await expect(reserveReplacementStock(input(), asTx(db))).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  });
  it.each([null, { id: 7, deletedAt: new Date(), status: 'ACTIVE' }, { id: 7, deletedAt: null, status: 'INACTIVE' }])(
    'rejects unavailable seller item %s', async item => {
      const db = tx(); db.item.findUnique.mockResolvedValue(item);
      await expect(reserveReplacementStock(input(), asTx(db))).rejects.toThrow('ITEM_NOT_FOUND');
    });
  it.each([{ sales: [] }, { sales: [{ soldMovement: null }] },
    { sales: [{ soldMovement: { direction: 'IN', reason: 'SOLD', itemId: 7 } }] },
    { sales: [{ soldMovement: { direction: 'OUT', reason: 'OTHER', itemId: 7 } }] },
    { sales: [{ soldMovement: { direction: 'OUT', reason: 'SOLD', itemId: 8 } }] },
    { sales: [{ soldMovement: { direction: 'OUT', reason: 'SOLD', itemId: 7 } }, { soldMovement: {} }] }])(
    'rejects missing or ambiguous original sale', async ({ sales }) => {
      const db = tx(); db.stockReservation.findMany.mockResolvedValue(sales);
      await expect(reserveReplacementStock(input(), asTx(db))).rejects.toThrow('SALE_NOT_FOUND');
    });
  it('rejects insufficient available replacement stock', async () => {
    const db = tx(); mockBalance.mockResolvedValue(1);
    await expect(reserveReplacementStock(input(), asTx(db))).rejects.toThrow('UNAVAILABLE');
  });
});

describe('replacement stock commit and release', () => {
  const transition = () => { const { operationId, ...scope } = input(); return { ...scope, holdOperationId: operationId, itemId: 7, heldMovementId: 8 }; };
  it.each(['COMMIT', 'RELEASE'] as const)('balances the hold for %s', async phase => {
    const db = tx();
    db.replacementStockHold.findUnique.mockResolvedValue(hold());
    const result = await transitionReplacementStock(transition(), phase, asTx(db));
    expect(result).toMatchObject({ phase, releasedMovementId: 8, soldMovementId: phase === 'COMMIT' ? 9 : null });
    expect(db.movement.create).toHaveBeenCalledTimes(phase === 'COMMIT' ? 2 : 1);
    expect(db.replacementStockHold.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ state: phase === 'COMMIT' ? 'COMMITTED' : 'RELEASED' }),
    }));
  });
  it('rejects a missing or resolved hold', async () => {
    const db = tx(); db.replacementStockHold.findUnique.mockResolvedValue(null);
    await expect(transitionReplacementStock(transition(), 'COMMIT', asTx(db))).rejects.toThrow('HOLD_NOT_FOUND');
    db.replacementStockHold.findUnique.mockResolvedValue(hold());
    db.replacementStockHold.findUniqueOrThrow.mockResolvedValue({ ...hold(), state: 'RELEASED' });
    await expect(transitionReplacementStock(transition(), 'COMMIT', asTx(db))).rejects.toThrow('ALREADY_RESOLVED');
  });
  it.each(['shipmentId', 'entitlementId', 'sellerOrderId', 'sellerAccountId', 'purchaseId',
    'commerceSellerOrderId', 'commercePurchaseLineId', 'itemId', 'heldMovementId', 'quantity'] as const)(
    'rejects changed %s lineage', async key => {
      const db = tx(); db.replacementStockHold.findUnique.mockResolvedValue(hold());
      db.replacementStockHold.findUniqueOrThrow.mockResolvedValue({ ...hold(), [key]: key === 'itemId' || key === 'heldMovementId' || key === 'quantity' ? 99 : 'other' });
      await expect(transitionReplacementStock(transition(), 'COMMIT', asTx(db))).rejects.toThrow('SCOPE_CONFLICT');
    });
  it.each([{ sellerIdentifier: 'other', itemCode: 'item' }, { sellerIdentifier: 'seller', itemCode: 'other' }])(
    'rejects changed inventory ownership', async item => {
      const db = tx(); db.replacementStockHold.findUnique.mockResolvedValue(hold());
      db.item.findUniqueOrThrow.mockResolvedValue(item);
      await expect(transitionReplacementStock(transition(), 'COMMIT', asTx(db))).rejects.toThrow('SCOPE_CONFLICT');
    });
});
