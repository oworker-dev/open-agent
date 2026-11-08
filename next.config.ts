import type { NextConfig } from "next";
import { withEve } from "eve/next";
import { configureEveNextProductionPort } from "./scripts/production-preview-topology.mjs";

configureEveNextProductionPort();

const nextConfig: NextConfig = {
  distDir: nextBuildDirectory(),
  allowedDevOrigins: allowedDevelopmentOrigins(),
  async headers() {
    return [{
      source: "/embed",
      headers: [{
        key: "Content-Security-Policy",
        value: `frame-ancestors ${frameAncestorPolicy()}`,
      }],
    }];
  },
};

function nextBuildDirectory(): string {
  const configured = process.env.OPEN_AGENT_NEXT_DIST_DIR?.trim() || ".next";
  if (!/^\.next(?:-[A-Za-z0-9][A-Za-z0-9._-]*)?$/u.test(configured)) {
    throw new Error("OPEN_AGENT_NEXT_DIST_DIR must be .next or a dedicated .next-* directory.");
  }
  return configured;
}

function allowedDevelopmentOrigins(): string[] {
  const configured = process.env.AGENT_DEV_ALLOWED_ORIGINS?.trim();
  const origins = configured
    ? configured.split(",").map((value) => normalizeDevelopmentOrigin(value.trim()))
    : [];
  return [...new Set(["127.0.0.1", "localhost", ...origins])];
}

function normalizeDevelopmentOrigin(value: string): string {
  const hostname = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/iu;
  const ipv6 = /^\[[0-9a-f:]+\]$/iu;
  if (!value || value.length > 253 || !hostname.test(value) && !ipv6.test(value)) {
    throw new Error("AGENT_DEV_ALLOWED_ORIGINS must contain comma-separated hostnames or IP addresses.");
  }
  return value.toLowerCase();
}

function frameAncestorPolicy(): string {
  const configured = process.env.AGENT_EMBED_ALLOWED_ORIGINS?.trim();
  if (configured) {
    const origins = configured.split(",").map((value) => new URL(value.trim()).origin);
    return [...new Set(origins)].join(" ");
  }
  return process.env.NODE_ENV === "development"
    ? "http://localhost:4730 http://127.0.0.1:4730"
    : "'none'";
}

export default withEve(nextConfig);
