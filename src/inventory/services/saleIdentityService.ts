import { z } from 'zod';
import type { InventoryStockTransaction } from '@/inventory/services/stockReservationShared';
const identity = z.object({ version: z.literal(1), identifiers: z.array(z.string().min(1)).max(100) }).strict();
export const captureSaleIdentity = async (tx: InventoryStockTransaction, itemId: number, quantity: number) => {
  const components = await tx.component.findMany({ where: { itemId }, select: { instance: { select: { identifier: true } } } });
  const identifiers = components.flatMap(component => component.instance ? [component.instance.identifier] : []).sort();
  if (identifiers.length && quantity !== 1) throw new Error('SERIALIZED_SALE_QUANTITY_INVALID');
  return identity.parse({ version: 1, identifiers });
};
export const readSaleIdentity = (raw: unknown) => {
  const result = identity.safeParse(raw);
  if (!result.success) throw new Error('RETURN_RESTOCK_SALE_EVIDENCE_MISSING');
  return result.data;
};
export const validateReturnedIdentity = (snapshots: unknown[], observed: string[]) => {
  const expected = snapshots.flatMap(snapshot => readSaleIdentity(snapshot).identifiers).sort();
  if (JSON.stringify(expected) !== JSON.stringify([...observed].sort())) throw new Error('RETURN_RESTOCK_IDENTITY_MISMATCH');
};
