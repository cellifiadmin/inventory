// import { PaginationResponseType } from "../services/paginationService";
import { PaginationResponseType } from '../types/pagination';

import { APIGatewayProxyResultV2 } from "aws-lambda";
interface HTTPListResponseDataType extends PaginationResponseType {
    records: any[];
}
interface HTTPNoneListResponseDataType {
    records?: never;
}
export interface HTTPResponseBodyType {
    success: boolean;
    message: string | null;
    data?: HTTPListResponseDataType | HTTPNoneListResponseDataType;
    error?: {
        code: string;
        message: string;
    };
}


export type HTTPResponseTypeV2 = Omit<APIGatewayProxyResultV2, 'body'> & {
    body: HTTPResponseBodyType;
};