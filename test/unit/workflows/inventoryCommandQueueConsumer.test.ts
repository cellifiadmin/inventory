import { beforeEach, expect, it, jest } from '@jest/globals';
import type { SQSRecord } from 'aws-lambda';
const mockConsume = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockReturn = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock('@/inventory/services/workflows/inventoryCommandService', () => ({ consumeInventoryCommand: (...args: unknown[]) => mockConsume(...args) }));
jest.mock('@/inventory/services/workflows/returnRestockCommandService', () => ({ consumeReturnRestockCommand: (...args: unknown[]) => mockReturn(...args) }));
import { handler } from '@/handlers/sqs/reservation-operations/process';
const commerce = 'arn:aws:sqs:us-east-1:000000000000:commerce';
const fulfillment = 'arn:aws:sqs:us-east-1:000000000000:fulfillment';
const record = (messageId: string, eventSourceARN = commerce): SQSRecord => ({ messageId, eventSourceARN, eventSource: 'aws:sqs', body: '{}', receiptHandle: '', awsRegion: 'us-east-1', md5OfBody: '', attributes: { ApproximateReceiveCount: '1', SentTimestamp: '', SenderId: '', ApproximateFirstReceiveTimestamp: '' }, messageAttributes: {} });
beforeEach(() => { mockConsume.mockReset().mockResolvedValue({}); mockReturn.mockReset().mockResolvedValue({}); process.env.COMMERCE_COMMAND_QUEUE_ARN = commerce; process.env.FULFILLMENT_COMMAND_QUEUE_ARN = fulfillment; });
it('derives producer authority solely from the exact queue ARN', async () => {
  expect(await handler({ Records: [record('1'), record('2', fulfillment)] })).toEqual({ batchItemFailures: [] });
  expect(mockConsume.mock.calls).toEqual([[{}, 'commerce'], [{}, 'fulfillment']]);
});
it('routes return restock commands only through the Fulfillment authority', async () => {
  const body = JSON.stringify({ command: 'INVENTORY_APPLY_RETURN' });
  expect(await handler({ Records: [{ ...record('1', fulfillment), body }] })).toEqual({ batchItemFailures: [] });
  expect(mockReturn).toHaveBeenCalledWith({ command: 'INVENTORY_APPLY_RETURN' }, 'fulfillment');
  expect(mockConsume).not.toHaveBeenCalled();
});
it.each(['spoof', `${commerce}:other`])('rejects untrusted source %s and independently processes later Standard records', async arn => {
  expect(await handler({ Records: [record('1', arn), record('2')] })).toEqual({ batchItemFailures: [{ itemIdentifier: '1' }] });
  expect(mockConsume).toHaveBeenCalledTimes(1);
});
it('returns only failed records for malformed JSON or infrastructure rejection', async () => {
  expect(await handler({ Records: [{ ...record('1'), body: '{' }, record('2')] })).toEqual({ batchItemFailures: [{ itemIdentifier: '1' }] });
  mockConsume.mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValue({});
  expect(await handler({ Records: [record('3'), record('4')] })).toEqual({ batchItemFailures: [{ itemIdentifier: '3' }] });
});
it('rejects invalid, empty, equal and FIFO source configuration before any record effect', async () => {
  for (const pair of [['', fulfillment], [commerce, ''], [commerce, commerce], ['not-an-arn', fulfillment], [commerce, `${fulfillment}.fifo`], [`${commerce}.fifo`, fulfillment]]) {
    [process.env.COMMERCE_COMMAND_QUEUE_ARN, process.env.FULFILLMENT_COMMAND_QUEUE_ARN] = pair;
    await expect(handler({ Records: [record('1')] })).rejects.toThrow();
  }
  delete process.env.COMMERCE_COMMAND_QUEUE_ARN;
  await expect(handler({ Records: [] })).rejects.toThrow();
  process.env.COMMERCE_COMMAND_QUEUE_ARN = commerce; delete process.env.FULFILLMENT_COMMAND_QUEUE_ARN;
  await expect(handler({ Records: [] })).rejects.toThrow();
  expect(mockConsume).not.toHaveBeenCalled();
});
it('rejects a non-SQS event source independently', async () => {
  expect(await handler({ Records: [{ ...record('1'), eventSource: 'spoof' }, record('2')] })).toEqual({ batchItemFailures: [{ itemIdentifier: '1' }] });
  expect(mockConsume).toHaveBeenCalledTimes(1);
});
