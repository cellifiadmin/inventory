import {
  APIGatewayAuthorizerResultContext,
  APIGatewayRequestAuthorizerEventV2,
} from "aws-lambda";

const DEFAULT_OFFLINE_AUTH_ENDPOINT = "http://localhost:3019";
const DEFAULT_AUTH_FUNCTION_NAME = "cellifi-auth-local-authorizer";

type AuthorizerResult = {
  isAuthorized: boolean;
  context: APIGatewayAuthorizerResultContext;
};

const deny = (reason: string): AuthorizerResult => ({
  isAuthorized: false,
  context: { reason },
});

const parseFunctionNameFromArn = (value: string | undefined): string | null => {
  if (!value) return null;

  const marker = ":function:";
  const markerIndex = value.indexOf(marker);
  if (markerIndex === -1) return null;

  const functionPart = value.slice(markerIndex + marker.length);
  const functionName = functionPart.split(":")[0]?.trim();
  return functionName || null;
};

const resolveOfflineEndpoint = (): string | undefined => {
  const explicit = process.env.AUTH_SHARED_AUTHORIZER_OFFLINE_ENDPOINT?.trim();
  if (explicit) return explicit;

  if (process.env.IS_OFFLINE === "true") {
    return DEFAULT_OFFLINE_AUTH_ENDPOINT;
  }

  return undefined;
};

const resolveAuthorizerTarget = (): string => {
  const explicitFunctionName =
    process.env.AUTH_SHARED_AUTHORIZER_FUNCTION_NAME?.trim();
  if (explicitFunctionName) {
    return explicitFunctionName;
  }

  const authorizerArn = process.env.AUTH_SHARED_AUTHORIZER_ARN?.trim();
  return parseFunctionNameFromArn(authorizerArn) || DEFAULT_AUTH_FUNCTION_NAME;
};

const parsePayload = (payloadText: string): unknown => {
  return JSON.parse(payloadText);
};

const isAuthorizerResult = (value: unknown): value is AuthorizerResult => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybeResult = value as {
    isAuthorized?: unknown;
    context?: unknown;
  };

  return (
    typeof maybeResult.isAuthorized === "boolean" &&
    !!maybeResult.context &&
    typeof maybeResult.context === "object"
  );
};

const invokeOfflineAuthorizer = async (
  endpoint: string,
  functionName: string,
  event: APIGatewayRequestAuthorizerEventV2,
): Promise<AuthorizerResult> => {
  const baseUrl = endpoint.replace(/\/$/, "");
  const invokeUrl = `${baseUrl}/2015-03-31/functions/${encodeURIComponent(
    functionName,
  )}/invocations`;

  const response = await fetch(invokeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });

  if (!response.ok) {
    throw new Error(
      `Authorizer invocation failed with status ${response.status}`,
    );
  }

  const payloadText = await response.text();
  const parsedPayload = parsePayload(payloadText);

  if (!isAuthorizerResult(parsedPayload)) {
    throw new Error("Invalid authorizer response payload");
  }

  return parsedPayload;
};

export const handler = async (
  event: APIGatewayRequestAuthorizerEventV2,
): Promise<AuthorizerResult> => {
  try {
    const offlineEndpoint = resolveOfflineEndpoint();
    if (!offlineEndpoint) {
      return deny(
        "Offline shared authorizer proxy requires IS_OFFLINE=true or AUTH_SHARED_AUTHORIZER_OFFLINE_ENDPOINT",
      );
    }

    const invocationTarget = resolveAuthorizerTarget();
    return await invokeOfflineAuthorizer(offlineEndpoint, invocationTarget, event);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unauthorized";
    return deny(message);
  }
};
