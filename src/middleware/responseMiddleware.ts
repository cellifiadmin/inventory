import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { HTTPResponseTypeV2 } from "../types/http";


export const responseMiddleware = (handler: (event: APIGatewayProxyEventV2, context: any, user?: any) => Promise<HTTPResponseTypeV2>) => {

    return async (event: APIGatewayProxyEventV2, context: any, user?: any): Promise<APIGatewayProxyResultV2> => {
        const response = await handler(event, context, user);
        const standardResponse :APIGatewayProxyResultV2 = {
            ...response,
            body: JSON.stringify(response.body)
        };
        return standardResponse;
        
    }
};
