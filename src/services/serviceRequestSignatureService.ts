import { createHmac, timingSafeEqual } from 'crypto';

import createError from 'http-errors';
import { StatusCodes } from 'http-status-codes';

export const SERVICE_TIMESTAMP_HEADER = 'x-mp-timestamp';
export const SERVICE_SIGNATURE_HEADER = 'x-mp-signature';
const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

const resolveSigningSecret = (): string => {
  const secret = process.env.INTERNAL_SERVICE_REQUEST_SIGNING_SECRET?.trim();

  if (!secret) {
    throw new Error('INTERNAL_SERVICE_REQUEST_SIGNING_SECRET is required');
  }

  return secret;
};

const normalizeHeaders = (
  headers: Record<string, string | undefined>,
): Record<string, string> => {
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      normalized[key.toLowerCase()] = value;
    }
  }

  return normalized;
};

export const createServiceRequestSignature = (input: {
  timestamp: string;
  body: string;
  pathAndQuery: string;
}): string =>
  createHmac('sha256', resolveSigningSecret())
    .update(`${input.timestamp}.${input.pathAndQuery}.${input.body}`)
    .digest('hex');

export const assertServiceRequestSignature = (input: {
  headers: Record<string, string | undefined>;
  body: string;
  pathAndQuery: string;
  now?: Date;
}): void => {
  const normalizedHeaders = normalizeHeaders(input.headers);
  const timestamp = normalizedHeaders[SERVICE_TIMESTAMP_HEADER];
  const signature = normalizedHeaders[SERVICE_SIGNATURE_HEADER];

  if (!timestamp || !signature) {
    throw createError(
      StatusCodes.UNAUTHORIZED,
      'Missing service request signature headers',
    );
  }

  const parsedTimestamp = new Date(timestamp);
  if (Number.isNaN(parsedTimestamp.getTime())) {
    throw createError(StatusCodes.UNAUTHORIZED, 'Invalid service timestamp');
  }

  const now = input.now ?? new Date();
  if (Math.abs(now.getTime() - parsedTimestamp.getTime()) > MAX_TIMESTAMP_SKEW_MS) {
    throw createError(StatusCodes.UNAUTHORIZED, 'Expired service signature');
  }

  const expectedSignature = createServiceRequestSignature({
    timestamp,
    body: input.body,
    pathAndQuery: input.pathAndQuery,
  });
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    throw createError(StatusCodes.UNAUTHORIZED, 'Invalid service request signature');
  }
};
