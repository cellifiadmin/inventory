import { describe, expect, it, jest } from '@jest/globals';

describe('blob CDN helper import safety', () => {
  it('does not throw during module import when public-url env vars are absent', () => {
    const originalCloudfrontDomain = process.env.CLOUDFRONT_DOMAIN;
    const originalPublicBaseUrl = process.env.OBJECT_STORAGE_PUBLIC_BASE_URL;

    delete process.env.CLOUDFRONT_DOMAIN;
    delete process.env.OBJECT_STORAGE_PUBLIC_BASE_URL;

    try {
      jest.resetModules();

      expect(() => {
        jest.isolateModules(() => {
          require('@/services/blobService/getCDNUrl');
        });
      }).not.toThrow();
    } finally {
      if (originalCloudfrontDomain === undefined) {
        delete process.env.CLOUDFRONT_DOMAIN;
      } else {
        process.env.CLOUDFRONT_DOMAIN = originalCloudfrontDomain;
      }

      if (originalPublicBaseUrl === undefined) {
        delete process.env.OBJECT_STORAGE_PUBLIC_BASE_URL;
      } else {
        process.env.OBJECT_STORAGE_PUBLIC_BASE_URL = originalPublicBaseUrl;
      }

      jest.resetModules();
    }
  });
});
