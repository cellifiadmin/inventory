import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

type CorsOptions = {
    allowOrigin?: string[];
    allowMethods?: string[];
    allowHeaders?:  string[];
    allowCredentials?: boolean;
    maxAge?: number; // Seconds
};

const defaultOptions: CorsOptions = {
    allowOrigin: [process.env.MP_FE_URL || ''],
    allowMethods: ['GET', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Cookie'],
    allowCredentials: true,
    maxAge: 86400, // 24 hours
};

export const corsMiddleware = (handler: (event: APIGatewayProxyEventV2, context: any) => Promise<APIGatewayProxyResultV2>, options: CorsOptions = {}) => {
    const corsOptions: CorsOptions = { ...defaultOptions, ...options };

    return async (event: APIGatewayProxyEventV2, context: any): Promise<APIGatewayProxyResultV2> => {
        if (event.requestContext?.http?.method === 'OPTIONS') {
            const headers: Record<string, string> = {};
            headers['Access-Control-Allow-Origin'] = corsOptions.allowOrigin?.join(',') || '';
            headers['Access-Control-Allow-Methods'] = corsOptions.allowMethods?.join(',') || '';
            headers['Access-Control-Allow-Headers'] = corsOptions.allowHeaders?.join(',') || '';
            headers['Access-Control-Allow-Credentials'] = corsOptions.allowCredentials?.toString() || '';
            headers['Access-Control-Max-Age'] = corsOptions.maxAge?.toString() || '';
            return {
                statusCode: 204, // No content
                headers,
                body: ''
            }; 
        } else {
            return await handler(event, context);
        }
    }
};
