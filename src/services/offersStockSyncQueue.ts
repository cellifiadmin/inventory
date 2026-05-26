import { createHash } from 'crypto';

import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';

import { resolveAwsClientConfig } from '@/lib/awsClientConfig';

const sqsClient = new SQSClient({
  ...resolveAwsClientConfig(),
  maxAttempts: 2,
});

const getQueueUrl = () => process.env.OFFERS_STOCK_SYNC_QUEUE_URL?.trim();

export type OffersStockSyncMessage = {
  sellerIdentifier: string;
  itemCode: string;
  direction: 'OUT';
};

export type OffersImageSyncPhoto = {
  blobId: number;
  checksum: string;
  key: string;
  name: string | null;
  mimeType: string;
  size: number;
  assetRef?: string | null;
  cdnUrl: string;
};

export type OffersImageSyncMessage = {
  eventType: 'IMAGES_UPDATED';
  sellerIdentifier: string;
  itemCode: string;
  mainPhoto: OffersImageSyncPhoto | null;
  photos: OffersImageSyncPhoto[];
};

type OffersSyncMessage = OffersStockSyncMessage | OffersImageSyncMessage;

type EnqueueOffersStockSyncOptions = {
  deduplicationKey: string;
};

const buildMessageGroupId = ({
  sellerIdentifier,
  itemCode,
}: OffersSyncMessage) => `${sellerIdentifier}::${itemCode}`;

const buildRawDeduplicationId = (
  message: OffersSyncMessage,
  { deduplicationKey }: EnqueueOffersStockSyncOptions,
) => {
  const eventKey =
    'eventType' in message ? message.eventType : message.direction;

  return `${message.sellerIdentifier}:${message.itemCode}:${eventKey}:${deduplicationKey}`;
};

const buildDeduplicationId = (
  message: OffersSyncMessage,
  options: EnqueueOffersStockSyncOptions,
) => {
  const eventKey =
    'eventType' in message ? message.eventType : message.direction;
  const rawDeduplicationId = buildRawDeduplicationId(message, options);
  const digest = createHash('sha256').update(rawDeduplicationId).digest('hex');

  return `${eventKey}:${digest}`;
};

const enqueueOffersSync = async (
  message: OffersSyncMessage,
  options: EnqueueOffersStockSyncOptions,
) => {
  const queueUrl = getQueueUrl();

  if (!queueUrl) {
    throw createError(
      StatusCodes.INTERNAL_SERVER_ERROR,
      'Offers stock sync queue not configured',
    );
  }

  try {
    return await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(message),
        MessageGroupId: buildMessageGroupId(message),
        MessageDeduplicationId: buildDeduplicationId(message, options),
      }),
    );
  } catch (error) {
    console.error('Failed to enqueue offers stock sync', error);
    throw createError(
      StatusCodes.INTERNAL_SERVER_ERROR,
      'Failed to enqueue offers stock sync',
    );
  }
};

export const enqueueOffersStockSync = async (
  message: OffersStockSyncMessage,
  options: EnqueueOffersStockSyncOptions,
) => enqueueOffersSync(message, options);

export const enqueueOffersImageSync = async (
  message: OffersImageSyncMessage,
  options: EnqueueOffersStockSyncOptions,
) => enqueueOffersSync(message, options);
