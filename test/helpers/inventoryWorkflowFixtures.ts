import { randomUUID } from 'node:crypto';
import { inventoryOperationInputHash, type InventoryCommandEnvelope } from '@/inventory/types/inventoryWorkflowEnvelope';
export const commandEnvelope = (command: InventoryCommandEnvelope['command'], input: InventoryCommandEnvelope['input']): InventoryCommandEnvelope => {
  const commit = command === 'INVENTORY_COMMIT';
  const resourceId = 'commerceSellerOrderId' in input ? input.commerceSellerOrderId : input.checkoutId;
  const envelope = { type: 'WORKFLOW_COMMAND' as const, schemaVersion: 1 as const,
    producer: commit ? 'fulfillment' as const : 'commerce' as const, command, input,
    eventId: randomUUID(), operationId: randomUUID(), executionId: randomUUID(), correlationId: randomUUID(),
    workflowKind: commit ? 'FULFILLMENT_COMMIT' : 'CHECKOUT', stepKey: command,
    participantKey: command === 'INVENTORY_RESERVE' ? `inventory:checkout:${input.checkoutId}` : 'inventory:seller',
    resourceType: commit ? 'seller_order' : 'checkout', resourceId, resourceVersion: input.version,
    actorIdentifier: 'buyer', deadlineAt: new Date(Date.now() + 60000).toISOString(),
  };
  // The discriminated command and input pair is validated by every consumer.
  return { ...envelope, operationInputHash: inventoryOperationInputHash(envelope) } as InventoryCommandEnvelope;
};
export const rehashCommand = (event: InventoryCommandEnvelope): InventoryCommandEnvelope => ({ ...event, operationInputHash: inventoryOperationInputHash(event) });
