import { beforeEach, expect, it, jest } from '@jest/globals';
import { workflowInputHash } from '@/inventory/services/workflows/workflowIdentity';
const fn = (value: any) => jest.fn<any>().mockResolvedValue(value);
const tx:any = { $queryRaw:fn([]),item:{findUnique:fn({id:7,deletedAt:null})},stockReservation:{findMany:fn([])},
 movement:{aggregate:fn({_sum:{quantity:null}}),create:fn({id:9})},
 inventoryCommand:{findUnique:fn(null),create:fn({state:'RECEIVED'}),update:fn({})},
 inventoryInboxEvent:{createMany:fn({count:1}),findUniqueOrThrow:fn({})},inventoryResultOutbox:{create:fn({})} };
jest.mock('@/inventory/services/stockReservationShared',()=>({lockStockItems:jest.fn(async()=>{}),withStockTransaction:(work:any)=>work(tx)}));
import { consumeCancellationRestorationCommand, parseCancellationRestorationCommand } from '@/inventory/services/workflows/cancellationRestorationCommandService';
import { cancellationRestorationInputSchema } from '@/inventory/services/cancellationRestorationService';
const command=()=>{
 const input={cancellationId:'cancel',sellerOrderId:'order',sellerAccountId:'seller',purchaseId:'purchase',commerceSellerOrderId:'commercial-order',lines:[{sourceInvId:'item',commercePurchaseLineId:'line',quantity:1}]};
 const descriptor={kind:'CANCELLATION_RESTORE',resourceType:'cancellation',resourceId:'cancel',resourceVersion:1,stepKey:'INVENTORY_APPLY_CANCELLATION',participantKey:'inventory:seller',input,deadlineAt:'2030-01-01T00:00:00.000Z'};
 return {type:'WORKFLOW_COMMAND',schemaVersion:1,producer:'fulfillment',command:descriptor.stepKey,eventId:'event',operationId:'cancellation:cancel:restore:v1',executionId:'execution',correlationId:'order',operationInputHash:workflowInputHash(descriptor),workflowKind:descriptor.kind,stepKey:descriptor.stepKey,participantKey:descriptor.participantKey,resourceType:descriptor.resourceType,resourceId:descriptor.resourceId,resourceVersion:1,actorIdentifier:'actor',deadlineAt:descriptor.deadlineAt,input};
};
beforeEach(()=>{jest.clearAllMocks();
 tx.item.findUnique.mockResolvedValue({id:7,deletedAt:null});
 tx.stockReservation.findMany.mockResolvedValue([{id:'reservation',soldMovement:{id:8,itemId:7,direction:'OUT',reason:'SOLD',quantity:1}}]);
 tx.inventoryCommand.findUnique.mockResolvedValue(null);tx.inventoryCommand.create.mockResolvedValue({state:'RECEIVED'});
 tx.inventoryInboxEvent.createMany.mockResolvedValue({count:1});
 tx.inventoryInboxEvent.findUniqueOrThrow.mockResolvedValue({id:'receipt',operationId:command().operationId,payloadHash:workflowInputHash(command())});
});
it('restores the original sold units and atomically retains the command result for asynchronous delivery',async()=>{
 const result=await consumeCancellationRestorationCommand(command(),'fulfillment');
 expect(result).toMatchObject({resourceType:'cancellation',outcome:'SUCCEEDED',result:{cancellationId:'cancel',lines:[{commercePurchaseLineId:'line',quantity:1,itemId:7,movementId:9}]}});
 expect(tx.movement.create).toHaveBeenCalledWith({data:expect.objectContaining({direction:'IN',reason:'RELEASED',metadata:expect.objectContaining({restorationKind:'CANCELLATION',originalSaleMovementId:8})})});
 expect(tx.inventoryCommand.update).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({state:'SUCCEEDED'})}));
 expect(tx.inventoryResultOutbox.create).toHaveBeenCalledTimes(1);
});
it('validates deterministic operation, scope, producer and nonduplicated quantities',()=>{
 expect(parseCancellationRestorationCommand(command())).toMatchObject({resourceId:'cancel'});
 for(const changed of [{operationId:'another'},{resourceId:'another'},{participantKey:'other'},{operationInputHash:'a'.repeat(64)}])expect(()=>parseCancellationRestorationCommand({...command(),...changed})).toThrow();
 expect(()=>consumeCancellationRestorationCommand(command(),'commerce')).toThrow('INVENTORY_COMMAND_SOURCE_MISMATCH');
 expect(()=>cancellationRestorationInputSchema.parse({...command().input,lines:[...command().input.lines,...command().input.lines]})).toThrow();
});
it('refuses changed envelopes, conflicting receipts and an unexpected terminal state',async()=>{
 const event=command();const {eventId,...immutable}=event;const envelopeHash=workflowInputHash(immutable);
 tx.inventoryCommand.findUnique.mockResolvedValueOnce({envelopeHash:'wrong'});
 await expect(consumeCancellationRestorationCommand(event,'fulfillment')).rejects.toThrow('INVENTORY_COMMAND_ENVELOPE_CONFLICT');
 tx.inventoryCommand.findUnique.mockResolvedValue({envelopeHash,state:'FAILED'});
 tx.inventoryInboxEvent.findUniqueOrThrow.mockResolvedValueOnce({operationId:'other'});
 await expect(consumeCancellationRestorationCommand(event,'fulfillment')).rejects.toThrow('INVENTORY_INBOX_CONFLICT');
 tx.inventoryInboxEvent.findUniqueOrThrow.mockResolvedValueOnce({operationId:event.operationId,payloadHash:'wrong'});
 await expect(consumeCancellationRestorationCommand(event,'fulfillment')).rejects.toThrow('INVENTORY_INBOX_CONFLICT');
 await expect(consumeCancellationRestorationCommand(event,'fulfillment')).rejects.toThrow('CANCELLATION_RESTORE_COMMAND_TERMINAL');
 expect(tx.movement.create).not.toHaveBeenCalled();
});
it('replays the retained result without restoring again and redelivers only for a fresh receipt',async()=>{
 const event=command();const result=await consumeCancellationRestorationCommand(event,'fulfillment');
 const {eventId,...immutable}=event;
 tx.inventoryCommand.findUnique.mockResolvedValue({state:'SUCCEEDED',envelopeHash:workflowInputHash(immutable),result});
 jest.clearAllMocks();tx.inventoryInboxEvent.createMany.mockResolvedValueOnce({count:0}).mockResolvedValueOnce({count:1});
 expect(await consumeCancellationRestorationCommand(event,'fulfillment')).toEqual(result);
 expect(await consumeCancellationRestorationCommand(event,'fulfillment')).toEqual(result);
 expect(tx.movement.create).not.toHaveBeenCalled();expect(tx.inventoryResultOutbox.create).toHaveBeenCalledTimes(1);
});
