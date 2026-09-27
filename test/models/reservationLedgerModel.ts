// Independent integer ledger used as the oracle for owner reservation behavior.
// Keep this free of Inventory services and database transition helpers.
export const stockModelSeeds = [18, 20260926, 713, 991];

export const stockModelRandom = (seed: number) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed;
};

export class ReservationLedgerModel {
  available: number;

  constructor(initialQuantity: number) {
    this.available = initialQuantity;
  }

  canReserve(quantity: number) {
    return quantity <= this.available;
  }

  reserve(quantity: number) {
    if (!this.canReserve(quantity)) throw new Error('Insufficient model stock');
    this.available -= quantity;
  }

  release(quantity: number) {
    this.available += quantity;
  }
}
