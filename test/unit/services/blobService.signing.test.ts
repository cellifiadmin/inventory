import { describe, expect, it, jest } from '@jest/globals';

jest.mock('@/lib/prismaInventory', () => ({ __esModule: true, default: {} }));

import { generateDownloadUrl, generatePreviewUrl } from '@/services/blobService';

describe('blob signed URL expiration', () => {
  it.each([
    ['download', generateDownloadUrl, 'attachment'],
    ['preview', generatePreviewUrl, 'inline'],
  ] as const)('expires %s URLs after five minutes', async (_label, generateUrl, disposition) => {
    const url = new URL(await generateUrl({ key: 'photos/test.jpeg', name: 'test', extension: 'jpeg' }));
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('response-content-disposition')).toContain(disposition);
    expect(url.pathname).toContain('/photos/test.jpeg');
  });
});
