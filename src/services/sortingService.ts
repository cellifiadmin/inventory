import { Prisma as InventoryPrisma } from '@/lib/prismaInventoryTypes';
import { z } from 'zod';

import { SortingInputType } from '../types/sorting';

const sortItemSchema = z.string().refine(
    (value: string) => /^[^-]+(-(asc|desc))?$/.test(value),
    (value: string) => ({
        message: `Invalid sort format in ${value}. Expected format: 'field-asc/desc' or 'field' (e.g., 'name-desc', 'name')`
    })
);

const createValidFieldsSchema = (validFields: string[]) =>
    z.string().refine(
        (item) => {
            const [field] = item.split('-');
            return validFields.includes(field);
        },
        (item) => {
            const [field] = item.split('-');
            return { message: `Invalid sorting by ${field}. Use ${validFields.join(', ')}` }
        }
    );


export const validateSorting = (
    queryParams: Record<string, any> | undefined | null,
    validFields: string[] = ['id']
): any[] | undefined => {
    if (!queryParams?.sortBy) return undefined;

    const result = z.object({sortBy: z.string()
        .transform(str => str.split(','))
        .pipe(z.array(sortItemSchema))
        .pipe(z.array(createValidFieldsSchema(validFields)))
        .transform(items => items.map(item => {
            const [field, dir] = item.split('-');
            const sortOrder = dir === 'desc'
              ? InventoryPrisma.SortOrder.desc
              : InventoryPrisma.SortOrder.asc;
            return { [field]: sortOrder };
        }))})
        .parse(queryParams);
    return result.sortBy;
};

export const getSortingQueryParams = (
  sortBy?: SortingInputType,
): Record<string, InventoryPrisma.SortOrder>[] | undefined => {
    if (!sortBy) return undefined;
    return sortBy.map(sort => ({ [sort.field]: sort.direction as InventoryPrisma.SortOrder }));
};
