import type { SQSClientConfig } from '@aws-sdk/client-sqs';

type AwsClientEnv = Partial<
  Record<
    | 'CELLIFI_AWS_ACCESS_KEY_ID'
    | 'CELLIFI_AWS_SECRET_ACCESS_KEY'
    | 'AWS_ACCESS_KEY_ID'
    | 'AWS_SECRET_ACCESS_KEY'
    | 'AWS_ENDPOINT_URL'
    | 'AWS_DEFAULT_REGION'
    | 'AWS_REGION'
    | 'CELLIFI_AWS_REGION',
    string
  >
>;

const trimToUndefined = (value?: string): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const resolveAwsCredentialValue = (
  explicitValue?: string,
  fallbackValue?: string
): string => {
  return trimToUndefined(explicitValue) || trimToUndefined(fallbackValue) || 'test';
};

const resolveAwsRegion = (env: AwsClientEnv): string =>
  trimToUndefined(env.CELLIFI_AWS_REGION) ||
  trimToUndefined(env.AWS_DEFAULT_REGION) ||
  trimToUndefined(env.AWS_REGION) ||
  'us-east-1';

export const resolveAwsClientConfig = (
  env: AwsClientEnv = process.env as AwsClientEnv
): SQSClientConfig => {
  const region = resolveAwsRegion(env);
  const endpoint = trimToUndefined(env.AWS_ENDPOINT_URL);

  if (!endpoint) {
    return { region };
  }

  return {
    region,
    endpoint,
    credentials: {
      accessKeyId: resolveAwsCredentialValue(
        env.CELLIFI_AWS_ACCESS_KEY_ID,
        env.AWS_ACCESS_KEY_ID
      ),
      secretAccessKey: resolveAwsCredentialValue(
        env.CELLIFI_AWS_SECRET_ACCESS_KEY,
        env.AWS_SECRET_ACCESS_KEY
      ),
    },
  };
};
