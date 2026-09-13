import path from 'node:path';

const generatedClient = path.resolve(__dirname, '../../../node_modules/.prisma/inventoryClient');
const shared = globalThis as unknown as { prismaInventory?: unknown };
type QueryInput = {
  model: string;
  operation: string;
  args: Record<string, unknown>;
  query: (args: Record<string, unknown>) => Promise<unknown>;
};
type Extension = {
  query: { $allModels: { $allOperations: (input: QueryInput) => Promise<unknown> } };
};

describe('Inventory Prisma runtime wrapper without a database connection', () => {
  const originalEnv = process.env;
  const originalGlobal = shared.prismaInventory;
  let extension: Extension;
  const extended = { fixture: 'extended-client' };
  const base = {
    $extends: jest.fn((value: Extension) => {
      extension = value;
      return extended;
    }),
  };
  const constructor = jest.fn(() => base);
  const load = (env: NodeJS.ProcessEnv, cached = false) => {
    process.env = env;
    if (cached) shared.prismaInventory = base;
    else delete shared.prismaInventory;
    jest.doMock(generatedClient, () => ({ PrismaClient: constructor }));
    let loaded: { default: unknown; prismaInventory: unknown };
    jest.isolateModules(() => {
      loaded = require('@/lib/prismaInventory');
    });
    expect(loaded!.default).toBe(extended);
    expect(loaded!.prismaInventory).toBe(extended);
  };
  beforeEach(() => {
    constructor.mockClear();
    base.$extends.mockClear();
  });
  afterEach(() => {
    process.env = originalEnv;
    if (originalGlobal === undefined) delete shared.prismaInventory;
    else shared.prismaInventory = originalGlobal;
    jest.dontMock(generatedClient);
    jest.restoreAllMocks();
  });

  it('uses the Inventory datasource and rewrites the packaged Lambda engine path', () => {
    load({
      NODE_ENV: 'production',
      AWS_LAMBDA_FUNCTION_NAME: 'inventory-fixture',
      PRISMA_QUERY_ENGINE_LIBRARY: '/var/task/node_modules/.prisma/client/engine.node',
      INVENTORY_DATABASE_URL: 'inventory-fixture-url',
      DATABASE_URL: 'unused-fixture-url',
    });
    expect(constructor).toHaveBeenCalledWith({
      log: ['query', 'error', 'warn', 'info'],
      datasources: { inventoryDb: { url: 'inventory-fixture-url' } },
      __internal: {
        engine: { binaryPath: '/var/task/node_modules/.prisma/inventoryClient/engine.node' },
      },
    });
    expect(shared.prismaInventory).toBeUndefined();
  });

  it.each([
    { NODE_ENV: 'test' },
    { NODE_ENV: 'test', PRISMA_QUERY_ENGINE_LIBRARY: '/irrelevant/local/engine.node' },
    { NODE_ENV: 'test', AWS_LAMBDA_FUNCTION_NAME: 'inventory-fixture' },
    {
      NODE_ENV: 'test',
      AWS_LAMBDA_FUNCTION_NAME: 'inventory-fixture',
      PRISMA_QUERY_ENGINE_LIBRARY: '',
    },
    {
      NODE_ENV: 'test',
      AWS_LAMBDA_FUNCTION_NAME: 'inventory-fixture',
      PRISMA_QUERY_ENGINE_LIBRARY: '  ',
    },
  ])('omits unusable engine overrides and caches one development client: %j', (env) => {
    load({ ...env, DATABASE_URL: 'shared-fixture-url' });
    expect(constructor).toHaveBeenCalledWith({
      log: ['query', 'error', 'warn', 'info'],
      datasources: { inventoryDb: { url: 'shared-fixture-url' } },
    });
    expect(process.env.PRISMA_QUERY_ENGINE_LIBRARY).toBeUndefined();
    expect(shared.prismaInventory).toBe(base);
  });

  it('reuses a retained client on development module reload', () => {
    load({ NODE_ENV: 'test' }, true);
    expect(constructor).not.toHaveBeenCalled();
    expect(base.$extends).toHaveBeenCalledTimes(1);
  });

  it.each([999, 1000, 1001])(
    'preserves query results and reports only queries over one second: %i',
    async (duration) => {
      load({ NODE_ENV: 'test' });
      jest
        .spyOn(Date, 'now')
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(100 + duration);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const args = { where: { id: 'fixture-item' } },
        result = { id: 'fixture-item' };
      const query = jest.fn(async () => result);
      expect(
        await extension.query.$allModels.$allOperations({
          model: 'Item',
          operation: 'findUnique',
          args,
          query,
        }),
      ).toBe(result);
      expect(query).toHaveBeenCalledWith(args);
      if (duration > 1000)
        expect(warn).toHaveBeenCalledWith(`Slow inventory query detected (${duration}ms):`, {
          model: 'Item',
          operation: 'findUnique',
          args,
        });
      else expect(warn).not.toHaveBeenCalled();
    },
  );

  it('retains the original query failure after reporting it', async () => {
    load({ NODE_ENV: 'test' });
    const error = new Error('Synthetic query failure');
    const report = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      extension.query.$allModels.$allOperations({
        model: 'Item',
        operation: 'create',
        args: {},
        query: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
    expect(report).toHaveBeenCalledWith('Inventory Prisma error:', error);
  });
});
