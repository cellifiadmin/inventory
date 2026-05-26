export interface PaginationInputType {
    page: number;
    perPage: number;
    maxPerPage: number;
}


export interface PaginationResponseType  {
    total: number;
    filteredTotal: number;
    page: number;
    perPage: number;
    totalPages: number;
    firstPage: number | null;
    lastPage: number | null;
    nextPage: number | null;
    previousPage: number | null;
    pageTotal: number;
    maxPerPage: number;
}
