import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const configured = process.env.AGENT_EMBED_ALLOWED_ORIGINS?.trim();
if (!configured) {
  throw new Error(
    "AGENT_EMBED_ALLOWED_ORIGINS is required to verify the production Agent embed build.",
  );
}

const expected = normalizedOrigins(configured);
const distDir = process.env.OPEN_AGENT_NEXT_DIST_DIR?.trim() || ".next";
if (!/^\.next(?:-[A-Za-z0-9][A-Za-z0-9._-]*)?$/u.test(distDir)) {
  throw new Error("OPEN_AGENT_NEXT_DIST_DIR must be .next or a dedicated .next-* directory.");
}
const manifestPath = resolve(distDir, "routes-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const embedRule = manifest.headers?.find((rule) => rule.source === "/embed");
const csp = embedRule?.headers?.find(
  (header) => header.key.toLowerCase() === "content-security-policy",
)?.value;

if (typeof csp !== "string") {
  throw new Error("The production build does not contain a CSP header for /embed.");
}

const actual = frameAncestors(csp);
if (actual.length === 0) {
  throw new Error("The production /embed CSP does not contain frame-ancestors.");
}
if (!sameValues(actual, expected)) {
  throw new Error(
    `The production /embed frame-ancestors do not match AGENT_EMBED_ALLOWED_ORIGINS. Expected ${expected.join(
      " ",
    )}; received ${actual.join(" ")}.`,
  );
}

console.log(JSON.stringify({ frameAncestors: actual, ok: true }));

function normalizedOrigins(value) {
  const origins = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const url = new URL(entry);
      if (url.origin !== entry) {
        throw new Error(
          `AGENT_EMBED_ALLOWED_ORIGINS must contain exact origins; received ${JSON.stringify(entry)}.`,
        );
      }
      return url.origin;
    });
  if (origins.length === 0) {
    throw new Error("AGENT_EMBED_ALLOWED_ORIGINS must contain at least one exact origin.");
  }
  return [...new Set(origins)].sort();
}

function frameAncestors(policy) {
  const directive = policy
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("frame-ancestors "));
  if (!directive) return [];
  return directive
    .slice("frame-ancestors ".length)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort();
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
