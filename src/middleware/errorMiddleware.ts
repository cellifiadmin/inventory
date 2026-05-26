// middlewares/errorMiddleware.ts
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { HttpError } from 'http-errors';
import { ZodError } from 'zod';

export const errorMiddleware = (
  handler: (event: APIGatewayProxyEventV2, context: any) => Promise<APIGatewayProxyResultV2>
) => {
  return async (event: APIGatewayProxyEventV2, context: any): Promise<APIGatewayProxyResultV2> => {
    try {
      return await handler(event, context);
    } catch (error: any) {
      console.error('Caught Error:', error);

      let statusCode = 500;
      let message = 'Internal Server Error';
      let errorLabel = 'SERVER_ERROR';
      let errorDetails = error;

      if (error instanceof HttpError) {
        statusCode = error.statusCode;
        errorLabel = error.name.toUpperCase().replace(/ /g, '_');
        errorDetails = error.details ?? error;

        try {
          const parsedErrors = JSON.parse(error.message);
          if (Array.isArray(parsedErrors) && parsedErrors.length > 0) {
            message = parsedErrors[0].message || error.message;
            errorLabel = 'VALIDATION_ERROR';
          } else {
            message = error.message;
          }
        } catch {
          message = error.message;
        }
      } else if (error instanceof ZodError) {
        statusCode = 400;
        message =
          error.errors.length > 0
            ? error.errors[0].message
            : 'Validation error';
        errorLabel = 'VALIDATION_ERROR';
      }

      return {
        statusCode,
        body: JSON.stringify({
          success: false,
          message,
          error: {
            label: errorLabel,
            details: errorDetails,
          },
        }),
      };
    }
  };
};
