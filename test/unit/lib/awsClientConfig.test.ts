import { resolveAwsClientConfig } from '@/lib/awsClientConfig';

describe('Inventory AWS client configuration', () => {
  const originalEnv = process.env;
  afterEach(() => {
    process.env = originalEnv;
  });

  it('keeps the cloud credential provider chain when no local endpoint is configured', () => {
    expect(
      resolveAwsClientConfig({ AWS_ACCESS_KEY_ID: 'unused', AWS_SECRET_ACCESS_KEY: 'unused' }),
    ).toEqual({ region: 'us-east-1' });
    expect(resolveAwsClientConfig({ AWS_ENDPOINT_URL: '  ' })).toEqual({ region: 'us-east-1' });
  });

  it.each([
    [
      {
        CELLIFI_AWS_REGION: ' eu-west-1 ',
        AWS_DEFAULT_REGION: 'us-west-2',
        AWS_REGION: 'us-east-2',
      },
      'eu-west-1',
    ],
    [
      { CELLIFI_AWS_REGION: ' ', AWS_DEFAULT_REGION: ' us-west-2 ', AWS_REGION: 'us-east-2' },
      'us-west-2',
    ],
    [{ AWS_DEFAULT_REGION: '', AWS_REGION: ' us-east-2 ' }, 'us-east-2'],
    [{ CELLIFI_AWS_REGION: '', AWS_DEFAULT_REGION: ' ', AWS_REGION: '' }, 'us-east-1'],
  ])('selects the configured region by explicit priority', (env, region) => {
    expect(resolveAwsClientConfig(env)).toEqual({ region });
  });

  it('uses explicit local credentials ahead of SDK environment credentials', () => {
    expect(
      resolveAwsClientConfig({
        AWS_ENDPOINT_URL: ' http://localhost:4567 ',
        CELLIFI_AWS_ACCESS_KEY_ID: ' local-access ',
        CELLIFI_AWS_SECRET_ACCESS_KEY: ' local-secret ',
        AWS_ACCESS_KEY_ID: 'sdk-access',
        AWS_SECRET_ACCESS_KEY: 'sdk-secret',
      }),
    ).toEqual({
      region: 'us-east-1',
      endpoint: 'http://localhost:4567',
      credentials: { accessKeyId: 'local-access', secretAccessKey: 'local-secret' },
    });
  });

  it('resolves each local credential independently and defaults only local endpoints to test credentials', () => {
    expect(
      resolveAwsClientConfig({
        AWS_ENDPOINT_URL: 'http://localhost:4567',
        CELLIFI_AWS_ACCESS_KEY_ID: ' ',
        CELLIFI_AWS_SECRET_ACCESS_KEY: '',
        AWS_ACCESS_KEY_ID: ' sdk-access ',
        AWS_SECRET_ACCESS_KEY: ' sdk-secret ',
      }),
    ).toMatchObject({ credentials: { accessKeyId: 'sdk-access', secretAccessKey: 'sdk-secret' } });
    expect(
      resolveAwsClientConfig({
        AWS_ENDPOINT_URL: 'http://localhost:4567',
        AWS_ACCESS_KEY_ID: '',
        AWS_SECRET_ACCESS_KEY: ' ',
      }),
    ).toMatchObject({ credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  });

  it('reads the current process environment when callers omit an override', () => {
    process.env = { AWS_REGION: 'eu-central-1', AWS_ENDPOINT_URL: 'http://localhost:4567' };
    expect(resolveAwsClientConfig()).toEqual({
      region: 'eu-central-1',
      endpoint: 'http://localhost:4567',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
  });
});
