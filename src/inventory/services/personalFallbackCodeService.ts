import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'crypto';

import createError from 'http-errors';
import { createClient } from 'redis';
import { StatusCodes } from 'http-status-codes';

type FallbackEnvelope = {
  key: string;
  hash: string;
};

type StoredFallbackRecord = {
  hash: string;
  accountIdentifier: string;
  imei: string;
  issuedAt: string;
};

type CacheAdapter = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
};

const FALLBACK_TTL_SECONDS = 15 * 60;
const FALLBACK_KEY_NAMESPACE = 'personal-stock-fallback';
type VendorRedisClient = ReturnType<typeof createClient>;

const memoryStore = new Map<string, { value: string; expiresAt: number }>();
let redisClientPromise: Promise<VendorRedisClient | null> | null = null;

const readServiceEncryptionSeed = () => {
  const value = process.env.SERVICE_ENCRYPTION_KEY?.trim();

  if (!value) {
    throw new Error('SERVICE_ENCRYPTION_KEY is required');
  }

  return value;
};

const getEncryptionKey = () =>
  createHash('sha256').update(readServiceEncryptionSeed()).digest();

const encryptEnvelope = (payload: FallbackEnvelope): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
};

const decryptEnvelope = (fallbackCode: string): FallbackEnvelope => {
  const [ivB64, tagB64, payloadB64] = fallbackCode.split('.');

  if (!ivB64 || !tagB64 || !payloadB64) {
    throw createError(StatusCodes.BAD_REQUEST, 'Fallback code invalid or expired.');
  }

  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      getEncryptionKey(),
      Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payloadB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');

    const parsed = JSON.parse(decrypted) as Partial<FallbackEnvelope>;

    if (!parsed.key || !parsed.hash) {
      throw new Error('Fallback envelope incomplete');
    }

    return {
      key: parsed.key,
      hash: parsed.hash,
    };
  } catch {
    throw createError(StatusCodes.BAD_REQUEST, 'Fallback code invalid or expired.');
  }
};

const usesInMemoryFallback = () =>
  !process.env.CACHE_REDIS_URL?.trim() &&
  (process.env.NODE_ENV === 'test' || process.env.IS_OFFLINE === 'true');

const getRedisClient = async (): Promise<VendorRedisClient | null> => {
  const url = process.env.CACHE_REDIS_URL?.trim();

  if (!url) {
    return null;
  }

  if (!redisClientPromise) {
    redisClientPromise = (async () => {
      const client = createClient({ url });

      client.on('error', (error) => {
        console.error('Vendor Redis client error', error);
      });

      await client.connect();

      return client;
    })();
  }

  return redisClientPromise;
};

const memoryCacheAdapter: CacheAdapter = {
  async get(key) {
    const record = memoryStore.get(key);

    if (!record) {
      return null;
    }

    if (record.expiresAt <= Date.now()) {
      memoryStore.delete(key);
      return null;
    }

    return record.value;
  },
  async set(key, value, ttlSeconds) {
    memoryStore.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  },
  async del(key) {
    memoryStore.delete(key);
  },
};

const getCacheAdapter = async (): Promise<CacheAdapter> => {
  const client = await getRedisClient();

  if (client) {
    return {
      get: async (key) => client.get(key),
      set: async (key, value, ttlSeconds) => {
        await client.set(key, value, { EX: ttlSeconds });
      },
      del: async (key) => {
        await client.del(key);
      },
    };
  }

  if (usesInMemoryFallback()) {
    return memoryCacheAdapter;
  }

  throw new Error('CACHE_REDIS_URL is required for personal fallback codes');
};

const normalizeCachePrefix = (value: string | undefined) => {
  const trimmed = value?.trim() ?? '';

  if (!trimmed) {
    return '';
  }

  return trimmed.endsWith(':') ? trimmed : `${trimmed}:`;
};

const buildFallbackCacheKey = (accountIdentifier: string) => {
  const prefix = normalizeCachePrefix(process.env.CACHE_REDIS_KEY_PREFIX);

  return `${prefix}${FALLBACK_KEY_NAMESPACE}:${accountIdentifier}:${randomUUID()}`;
};

const hashesMatch = (left: string, right: string) => {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
};

const parseStoredRecord = (value: string): StoredFallbackRecord | null => {
  try {
    const parsed = JSON.parse(value) as Partial<StoredFallbackRecord>;

    if (
      !parsed.hash ||
      !parsed.accountIdentifier ||
      !parsed.imei ||
      !parsed.issuedAt
    ) {
      return null;
    }

    return {
      hash: parsed.hash,
      accountIdentifier: parsed.accountIdentifier,
      imei: parsed.imei,
      issuedAt: parsed.issuedAt,
    };
  } catch {
    return null;
  }
};

export const issuePersonalInventoryFallbackCode = async ({
  accountIdentifier,
  imei,
}: {
  accountIdentifier: string;
  imei: string;
}) => {
  const cache = await getCacheAdapter();
  const hash = randomBytes(32).toString('hex');
  const key = buildFallbackCacheKey(accountIdentifier);

  await cache.set(
    key,
    JSON.stringify({
      hash,
      accountIdentifier,
      imei,
      issuedAt: new Date().toISOString(),
    } satisfies StoredFallbackRecord),
    FALLBACK_TTL_SECONDS,
  );

  return encryptEnvelope({ key, hash });
};

export const consumePersonalInventoryFallbackCode = async ({
  accountIdentifier,
  fallbackCode,
}: {
  accountIdentifier: string;
  fallbackCode: string;
}) => {
  const cache = await getCacheAdapter();
  const envelope = decryptEnvelope(fallbackCode);
  const storedValue = await cache.get(envelope.key);

  if (!storedValue) {
    throw createError(StatusCodes.BAD_REQUEST, 'Fallback code invalid or expired.');
  }

  const storedRecord = parseStoredRecord(storedValue);

  if (!storedRecord) {
    throw createError(StatusCodes.BAD_REQUEST, 'Fallback code invalid or expired.');
  }

  if (storedRecord.accountIdentifier !== accountIdentifier) {
    throw createError(StatusCodes.BAD_REQUEST, 'Fallback code invalid or expired.');
  }

  if (!hashesMatch(storedRecord.hash, envelope.hash)) {
    throw createError(StatusCodes.BAD_REQUEST, 'Fallback code invalid or expired.');
  }

  await cache.del(envelope.key);

  return storedRecord;
};
