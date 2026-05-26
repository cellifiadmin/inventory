import { PrismaClient as InventoryPrismaClient, Prisma as InventoryPrisma } from '../../node_modules/.prisma/inventoryClient';

const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
const enginePath = process.env.PRISMA_QUERY_ENGINE_LIBRARY;
const hasValidEnginePath = isLambda && enginePath && enginePath.trim() !== '';

if ((!isLambda || !hasValidEnginePath) && process.env.PRISMA_QUERY_ENGINE_LIBRARY !== undefined) {
  delete process.env.PRISMA_QUERY_ENGINE_LIBRARY;
}

const inventoryEnginePath = hasValidEnginePath
  ? enginePath.replace('/.prisma/client/', '/.prisma/inventoryClient/')
  : undefined;

const prismaInventoryClientOptions: any = {
  log: ['query', 'error', 'warn', 'info'] as InventoryPrisma.LogLevel[],
  datasources: {
    inventoryDb: {
      url: process.env.INVENTORY_DATABASE_URL || process.env.DATABASE_URL,
    },
  },
  ...(inventoryEnginePath
    ? {
        __internal: {
          engine: {
            binaryPath: inventoryEnginePath,
          },
        },
      }
    : {}),
};

declare global {
   
  var prismaInventory: InventoryPrismaClient | undefined;
}

const basePrismaInventory =
  global.prismaInventory || new InventoryPrismaClient(prismaInventoryClientOptions);

if (process.env.NODE_ENV !== 'production') {
  global.prismaInventory = basePrismaInventory;
}

export const prismaInventory = basePrismaInventory.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const before = Date.now();

        try {
          const result = await query(args);
          const duration = Date.now() - before;

          if (duration > 1000) {
            console.warn(`Slow inventory query detected (${duration}ms):`, { model, operation, args });
          }

          return result;
        } catch (error) {
          console.error('Inventory Prisma error:', error);
          throw error;
        }
      },
    },
  },
});

export default prismaInventory;
