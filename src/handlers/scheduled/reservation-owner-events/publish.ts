import { publishInventoryOwnerEvents } from '@/inventory/services/workflows/inventoryOwnerEventPublisher';
export const handler = async () => publishInventoryOwnerEvents();
