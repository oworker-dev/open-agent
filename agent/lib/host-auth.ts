import {
  ForbiddenError,
  extractBearerToken,
  type AuthFn,
  verifyJwtHmac,
  withAuthChallenges,
} from "eve/channels/auth";

export type HostJwtAuthConfig = {
  readonly algorithm?: "HS256" | "HS384" | "HS512";
  readonly audiences: readonly string[];
  readonly clockSkewSeconds?: number;
  readonly issuer: string;
  readonly secret: string;
};

const BEARER_CHALLENGE = [{ scheme: "Bearer" }] as const;

export function hostJwtAuth(config: HostJwtAuthConfig): AuthFn<Request> {
  const normalized = normalizeConfig(config);

  return withAuthChallenges(async (request) => {
    const token = extractBearerToken(request.headers.get("authorization"));
    if (!token) return null;

    const verified = await verifyJwtHmac(token, normalized);
    if (!verified.ok) return null;

    const tenantId = verified.sessionAuth.attributes.tenantId;
    if (typeof tenantId !== "string" || tenantId.trim().length === 0) {
      throw new ForbiddenError({
        code: "tenant_scope_required",
        message: "The host token does not contain a valid tenant scope.",
      });
    }

    const actorType = verified.sessionAuth.attributes.actorType;
    if (actorType !== undefined && actorType !== "user" && actorType !== "service") {
      throw new ForbiddenError({
        code: "actor_type_invalid",
        message: "The host token contains an invalid actor type.",
      });
    }

    const hostId = verified.sessionAuth.attributes.hostId;
    if (hostId !== undefined &&
        (typeof hostId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(hostId))) {
      throw new ForbiddenError({
        code: "host_id_invalid",
        message: "The host token contains an invalid hostId.",
      });
    }

    return {
      ...verified.sessionAuth,
      attributes: {
        ...verified.sessionAuth.attributes,
        tenantId: tenantId.trim(),
        ...(typeof hostId === "string" ? { hostId: hostId.trim() } : {}),
      },
      authenticator: "host-jwt",
      principalType: actorType ?? "user",
    };
  }, BEARER_CHALLENGE);
}

export function hostJwtAuthFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AuthFn<Request> {
  const secret = readOptional(environment.AGENT_HOST_JWT_SECRET);
  if (!secret) return withAuthChallenges(() => null, BEARER_CHALLENGE);

  return hostJwtAuth({
    algorithm: readAlgorithm(environment.AGENT_HOST_JWT_ALGORITHM),
    audiences: readRequiredList(
      environment.AGENT_HOST_JWT_AUDIENCE,
      "AGENT_HOST_JWT_AUDIENCE",
    ),
    clockSkewSeconds: readClockSkew(environment.AGENT_HOST_JWT_CLOCK_SKEW_SECONDS),
    issuer: readRequired(environment.AGENT_HOST_JWT_ISSUER, "AGENT_HOST_JWT_ISSUER"),
    secret,
  });
}

function normalizeConfig(config: HostJwtAuthConfig) {
  const secret = config.secret.trim();
  const issuer = config.issuer.trim();
  const audiences = config.audiences.map((audience) => audience.trim()).filter(Boolean);

  if (secret.length < 32) {
    throw new Error("AGENT_HOST_JWT_SECRET must contain at least 32 characters.");
  }
  if (!issuer) throw new Error("AGENT_HOST_JWT_ISSUER must not be empty.");
  if (audiences.length === 0) {
    throw new Error("AGENT_HOST_JWT_AUDIENCE must contain at least one audience.");
  }

  return {
    algorithm: config.algorithm ?? "HS256",
    audiences,
    clockSkewSeconds: config.clockSkewSeconds ?? 30,
    issuer,
    secret,
  } as const;
}

function readOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function readRequired(value: string | undefined, name: string): string {
  const normalized = readOptional(value);
  if (!normalized) throw new Error(`${name} is required when AGENT_HOST_JWT_SECRET is set.`);
  return normalized;
}

function readRequiredList(value: string | undefined, name: string): readonly string[] {
  return readRequired(value, name)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readAlgorithm(value: string | undefined): "HS256" | "HS384" | "HS512" {
  const normalized = readOptional(value) ?? "HS256";
  if (normalized === "HS256" || normalized === "HS384" || normalized === "HS512") {
    return normalized;
  }
  throw new Error("AGENT_HOST_JWT_ALGORITHM must be HS256, HS384, or HS512.");
}

function readClockSkew(value: string | undefined): number | undefined {
  const normalized = readOptional(value);
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 300) {
    throw new Error("AGENT_HOST_JWT_CLOCK_SKEW_SECONDS must be an integer from 0 to 300.");
  }
  return parsed;
}
