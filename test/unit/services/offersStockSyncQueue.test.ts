import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockSend = jest.fn<(command: { input: Record<string, unknown> }) => Promise<{ MessageId: string }>>();
const mockSendMessageCommand = jest.fn((input: Record<string, unknown>) => ({
  input,
}));
const mockSqsClient = jest.fn().mockImplementation(() => ({
  send: mockSend,
}));

jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: mockSqsClient,
  SendMessageCommand: mockSendMessageCommand,
}));

jest.mock('@/lib/awsClientConfig', () => ({
  resolveAwsClientConfig: jest.fn(() => ({})),
}));

import {
  enqueueOffersImageSync,
  enqueueOffersStockSync,
} from '@/services/offersStockSyncQueue';

describe('offersStockSyncQueue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OFFERS_STOCK_SYNC_QUEUE_URL =
      'https://sqs.us-east-1.amazonaws.com/123456789012/offers-stock-sync.fifo';
    mockSend.mockResolvedValue({ MessageId: 'message-1' });
  });

  it('bounds image sync deduplication IDs to the SQS FIFO limit', async () => {
    await enqueueOffersImageSync(
      {
        eventType: 'IMAGES_UPDATED',
        sellerIdentifier: 'seller-1',
        itemCode: 'B:PHONE:001:1',
        mainPhoto: {
          blobId: 5,
          checksum: '321ab7722186227932da2e4811a838856d681b7d8bc73483603ceda8c94663dc',
          key: 'products/item/image/main.jpeg',
          name: 'main.jpeg',
          mimeType: 'image/jpeg',
          size: 45208,
          cdnUrl: 'https://cdn.dev.cellifi.com/products/item/image/main.jpeg',
        },
        photos: [],
      },
      {
        deduplicationKey: [
          'item:2',
          'main:321ab7722186227932da2e4811a838856d681b7d8bc73483603ceda8c94663dc',
          'photos:',
          '6cc7eb79e6f956edc0dc714b3173f4ef2ce7c10afdad79b1e8bf331feb664676',
          '63dc93259338d55f3f9475982873948a1f7adabc359d8c69919ee40c62e250ef',
          '3c20cb556dae270fff72b8700c178f468b639c2095421f9a4c82490adf3eb6d9',
          '90d010fcb104381544e6c500a594c63af53f0c5743bb4ae62764906c0316f6b6',
          '029335c6c20fff37bd611663c5720fef002549f6549733f786662a759013c841',
          '321ab7722186227932da2e4811a838856d681b7d8bc73483603ceda8c94663dc',
          'bd23f64375003f71360edf696267769403cb25a81303df5a317014d62ae5fdd4',
          'e9989d6d55aeff1572b6c17ee494e92d526da27e0d074d17948207d05e4797fa',
          '2e573f1b95344f14f711b6277683b4397edb8bc88e8181d5a8a2fed4350c6434',
          '306d30ed07f2c793b88948de828f409c261db164453ecc69e2162de527202f70',
        ].join(':'),
      },
    );

    const commandInput = mockSend.mock.calls[0][0].input as Record<
      string,
      string
    >;

    expect(commandInput.MessageDeduplicationId.length).toBeLessThanOrEqual(128);
  });

  it('keeps stock sync deduplication IDs deterministic', async () => {
    await enqueueOffersStockSync(
      {
        sellerIdentifier: 'seller-1',
        itemCode: 'B:PHONE:001:1',
        direction: 'OUT',
      },
      {
        deduplicationKey: 'seller-1:B:PHONE:001:1:OUT',
      },
    );

    await enqueueOffersStockSync(
      {
        sellerIdentifier: 'seller-1',
        itemCode: 'B:PHONE:001:1',
        direction: 'OUT',
      },
      {
        deduplicationKey: 'seller-1:B:PHONE:001:1:OUT',
      },
    );

    const [firstCall, secondCall] = mockSend.mock.calls;
    const firstInput = firstCall[0].input as Record<string, string>;
    const secondInput = secondCall[0].input as Record<string, string>;

    expect(firstInput.MessageDeduplicationId).toBe(
      secondInput.MessageDeduplicationId,
    );
  });
});
