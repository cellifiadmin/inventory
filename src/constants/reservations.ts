export { ReservationState, ReservationOperationKind } from '.prisma/inventoryClient';
export const DEFAULT_STOCK_RESERVATION_TIMEOUT_MINUTES = 15;
export const STOCK_TRANSACTION_MAX_ATTEMPTS = 3;
export const STOCK_RESERVATION_EXPIRY_BATCH_SIZE = 100;
