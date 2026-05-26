import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { StatusCodes } from 'http-status-codes';
import createError from 'http-errors';
import { AuthUserType } from '@/types/userType';

type AuthorizerContextRecord = Record<string, unknown>;

const parseAuthorizerContext = (
  event: APIGatewayProxyEventV2,
): AuthorizerContextRecord | null => {
  const authorizer = (event.requestContext as { authorizer?: unknown } | undefined)
    ?.authorizer;

  if (!authorizer || typeof authorizer !== 'object') {
    return null;
  }

  const lambdaContext = (authorizer as { lambda?: unknown }).lambda;
  if (lambdaContext && typeof lambdaContext === 'object') {
    return lambdaContext as AuthorizerContextRecord;
  }

  return authorizer as AuthorizerContextRecord;
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

const isFinalAuthUser = (value: unknown): value is AuthUserType => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const user = value as Record<string, unknown>;
  const userIdentifier =
    typeof user.userIdentifier === 'string' ? user.userIdentifier.trim() : '';

  if (!userIdentifier) {
    return false;
  }

  if (!isStringArray(user.userRoles)) {
    return false;
  }

  if (user.userName !== undefined && !isNullableString(user.userName)) {
    return false;
  }

  return true;
};

const parseUserFromContext = (
  context: AuthorizerContextRecord,
): AuthUserType => {
  if (typeof context.authUser !== 'string' || context.authUser.trim().length === 0) {
    throw createError(StatusCodes.UNAUTHORIZED, 'Authentication required');
  }

  let parsedUser: unknown;
  try {
    parsedUser = JSON.parse(context.authUser);
  } catch {
    throw createError(StatusCodes.UNAUTHORIZED, 'Authentication required');
  }

  if (!isFinalAuthUser(parsedUser)) {
    throw createError(StatusCodes.UNAUTHORIZED, 'Authentication required');
  }

  const user = parsedUser as AuthUserType;
  const userIdentifier =
    typeof user.userIdentifier === 'string' ? user.userIdentifier.trim() : '';
  const accountIdentifier =
    typeof user.accountIdentifier === 'string' ? user.accountIdentifier.trim() : '';

  if (!userIdentifier) {
    throw createError(StatusCodes.UNAUTHORIZED, 'Authentication required');
  }

  if (!accountIdentifier) {
    throw createError(StatusCodes.UNAUTHORIZED, 'Authentication required');
  }

  return user;
};

/**
 * Authentication Middleware (Pure API Pattern)
 * Reads authenticated user context injected by shared API Gateway authorizer.
 */
export const authMiddleware = (
  handler: (
    event: APIGatewayProxyEventV2,
    context: any,
    user: AuthUserType,
  ) => Promise<APIGatewayProxyResultV2>,
) => {
  return async (
    event: APIGatewayProxyEventV2,
    context: any,
  ): Promise<APIGatewayProxyResultV2> => {
    const authorizerContext = parseAuthorizerContext(event);
    console.log('Parsed authorizer context', { authorizerContext });
    if (!authorizerContext) {
      throw createError(StatusCodes.UNAUTHORIZED, 'Authentication required');
    }

    const currentUser = parseUserFromContext(authorizerContext);
    return handler(event, context, currentUser);
  };
};
