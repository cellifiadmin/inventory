import { publishInventoryResults } from '@/inventory/services/workflows/inventoryResultPublisher';
export const handler = async () => publishInventoryResults();
