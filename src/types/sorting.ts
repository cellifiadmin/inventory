import { Prisma as InventoryPrisma } from '@/lib/prismaInventoryTypes';

export type SortDirection =
  | typeof InventoryPrisma.SortOrder.asc
  | typeof InventoryPrisma.SortOrder.desc;

type SingleSortingInputType = {
    field: string;
    direction?: SortDirection;
};

export type SortingInputType = SingleSortingInputType[];
