import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SECRET_FILE = new URL("../.eve/production-preview-signing-secret", import.meta.url);
const DEFAULT_HOST_JWT_SECRET_FILE = new URL("../.eve/production-preview-host-jwt-secret", import.meta.url);

/**
 * @param {{
 *   environment?: Readonly<Record<string, string | undefined>>,
 *   secretFile?: string | URL,
 * }} [options]
 */
export async function resolveProductionPreviewSigningSecret({
  environment = process.env,
  secretFile = DEFAULT_SECRET_FILE,
} = {}) {
  const configured = environment.AGENT_PREVIEW_SIGNING_SECRET?.trim();
  if (configured) return assertSigningSecret(configured, "AGENT_PREVIEW_SIGNING_SECRET");

  const path = secretFile instanceof URL ? fileURLToPath(secretFile) : resolve(secretFile);
  try {
    return assertSigningSecret((await readFile(path, "utf8")).trim(), path);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const generated = randomBytes(32).toString("base64url");
  try {
    await writeFile(path, `${generated}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return generated;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    return assertSigningSecret((await readFile(path, "utf8")).trim(), path);
  }
}

export async function resolveProductionPreviewHostJwtSecret({
  environment = process.env,
  secretFile = DEFAULT_HOST_JWT_SECRET_FILE,
} = {}) {
  return resolvePersistedSecret({
    configured: environment.AGENT_HOST_JWT_SECRET,
    environmentName: "AGENT_HOST_JWT_SECRET",
    secretFile,
  });
}

async function resolvePersistedSecret({ configured, environmentName, secretFile }) {
  if (configured?.trim()) return assertSigningSecret(configured.trim(), environmentName);
  const path = secretFile instanceof URL ? fileURLToPath(secretFile) : resolve(secretFile);
  try {
    return assertSigningSecret((await readFile(path, "utf8")).trim(), path);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const generated = randomBytes(32).toString("base64url");
  try {
    await writeFile(path, `${generated}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return generated;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    return assertSigningSecret((await readFile(path, "utf8")).trim(), path);
  }
}

function assertSigningSecret(value, source) {
  if (Buffer.byteLength(value, "utf8") < 32) {
    throw new Error(`${source} must contain at least 32 bytes.`);
  }
  return value;
}

function isMissingFile(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error) {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
