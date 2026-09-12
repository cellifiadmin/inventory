import type { SQSEvent } from 'aws-lambda';
import { consumeInventoryCommandBatch } from '@/inventory/services/workflows/inventoryCommandQueueConsumer';
export const handler = (event: SQSEvent) => consumeInventoryCommandBatch(event);
