import { consumeCancellationRestorationCommand } from '@/inventory/services/workflows/cancellationRestorationCommandService';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { z } from 'zod';
import { INVENTORY_WORKFLOW_ENV, InventoryCommandProducer, WORKFLOW_ERROR } from '@/constants/inventoryWorkflows';
import { consumeInventoryCommand } from '@/inventory/services/workflows/inventoryCommandService';
import { consumeReturnRestockCommand } from '@/inventory/services/workflows/returnRestockCommandService';

const standardQueueArn = z.string().regex(/^arn:[a-z0-9-]+:sqs:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,80}$/);
export const consumeInventoryCommandBatch = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const commerce = standardQueueArn.parse(process.env[INVENTORY_WORKFLOW_ENV.COMMERCE_COMMAND_ARN]?.trim());
  const fulfillment = standardQueueArn.parse(process.env[INVENTORY_WORKFLOW_ENV.FULFILLMENT_COMMAND_ARN]?.trim());
  if (commerce === fulfillment) throw new Error(WORKFLOW_ERROR.SOURCE_MISMATCH);
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    try {
      if (record.eventSource !== 'aws:sqs') throw new Error(WORKFLOW_ERROR.SOURCE_MISMATCH);
      const producer = record.eventSourceARN === commerce ? InventoryCommandProducer.commerce
        : record.eventSourceARN === fulfillment ? InventoryCommandProducer.fulfillment : null;
      if (!producer) throw new Error(WORKFLOW_ERROR.SOURCE_MISMATCH);
      const input = JSON.parse(record.body);
      await ((input as { command?: unknown }).command === 'INVENTORY_APPLY_RETURN'
        ? consumeReturnRestockCommand(input, producer)
        : (input as { command?: unknown }).command === 'INVENTORY_APPLY_CANCELLATION'
          ? consumeCancellationRestorationCommand(input, producer) : consumeInventoryCommand(input, producer));
    } catch { batchItemFailures.push({ itemIdentifier: record.messageId }); }
  }
  return { batchItemFailures };
};
