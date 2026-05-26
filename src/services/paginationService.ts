// src/services/paginationService.ts
import { z } from 'zod';
import { PaginationResponseType, PaginationInputType } from '../types/pagination';
import { isGreaterThanZeroInteger } from '@/lib/number';

// validate pagination
export const validatePagination = (
    queryParams: Record<string, any> | undefined | null ,
    defaultOptions: PaginationInputType = {
        page: 1,
        perPage: 10,
        maxPerPage: 100
    }
): PaginationInputType => {
    queryParams = queryParams ?? {}
    // Define Zod schema for pagination parameters
    const paginationSchema = z.object({
        maxPerPage: z.union([z.number(), z.string()])
            .refine(value => isGreaterThanZeroInteger(value), { message: "must be integer and greater than zero" })
            .default(defaultOptions.maxPerPage)
            .transform((value: string | number) => Number(value)),
        page: z.union([z.number(), z.string()])
            .refine(value => isGreaterThanZeroInteger(value), { message: "must be integer and greater than zero" }) 
            .default(defaultOptions.page)
            .transform((value: string | number) => Number(value)),
        perPage: z.union([z.number(), z.string()])
            .refine(value => isGreaterThanZeroInteger(value), { message: "must be integer and greater than zero" })
            .refine(value => value <= (queryParams?.maxPerPage || defaultOptions.maxPerPage), { message: "must be less than or equal to max per page" })
            .default(defaultOptions.perPage)
            .transform((value: string | number) => Number(value))
    });
    // Parse and validate
    return paginationSchema.parse(queryParams);

   
};
// create pagination query
export const getPaginationQueryParams= async (
    pagination: PaginationInputType
): Promise<{
    take: number;
    skip: number;
}> => {
    const take =  pagination.perPage
    const skip = (pagination.page - 1) * pagination.perPage
    return {
        take: take,
        skip: skip
    };
};
// create pagination response
export const createPaginationResponse = (
    total: number,
    filteredTotal: number,
    recordTotal: number,
    pagination: PaginationInputType
): PaginationResponseType => {
    const page = pagination.page
    const perPage = pagination.perPage
    const maxPerPage = pagination.maxPerPage
    const totalPages =  Math.ceil(filteredTotal / perPage)
    const lastPage = totalPages > 0 ? totalPages : null
    // const pageTotal = (totalPages * perPage) > filteredTotal && (page == lastPage) ? filteredTotal - (Math.floor(filteredTotal / perPage) * perPage) : perPage
    const pageTotal = recordTotal
    const nextPage = page + 1 > totalPages ? null : page + 1
    const previousPage = page - 1 < 1 ? null : page - 1
    return {
        total,
        filteredTotal,
        page,
        perPage,
        totalPages,
        firstPage: totalPages > 0 ? 1 : null,
        lastPage,
        nextPage,
        previousPage,
        pageTotal,
        maxPerPage
    };
};
