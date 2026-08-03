import { expireStockReservations } from '@/inventory/services/stockReservationExpiryService';

export const handler = async () => expireStockReservations();
