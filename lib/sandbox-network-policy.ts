import type { SandboxNetworkPolicy } from "eve/sandbox";

export type AgentSandboxNetworkMode = "isolated" | "standard" | "trusted";

export const DEFAULT_AGENT_SANDBOX_NETWORK_MODE: AgentSandboxNetworkMode = "isolated";

const STANDARD_NETWORK_DOMAINS = [
  "github.com",
  "*.github.com",
  "codeload.githubusercontent.com",
  "raw.githubusercontent.com",
  "*.githubusercontent.com",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "*.pypi.org",
  "pythonhosted.org",
  "*.pythonhosted.org",
  "crates.io",
  "*.crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "rubygems.org",
  "*.rubygems.org",
  "deno.land",
  "*.deno.land",
  "jsr.io",
  "*.jsr.io",
] as const;

/** Private, loopback, link-local, and metadata ranges are never reachable in standard mode. */
export const STANDARD_NETWORK_DENIED_SUBNETS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
] as const;

const NETWORK_MODES = new Set<AgentSandboxNetworkMode>([
  "isolated",
  "standard",
  "trusted",
]);
const DOMAIN_PATTERN = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/iu;
const MAX_NETWORK_DOMAINS = 128;

export function readAgentSandboxNetworkMode(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AgentSandboxNetworkMode {
  const configured = environment.AGENT_SANDBOX_NETWORK_MODE?.trim().toLowerCase();
  if (!configured) return DEFAULT_AGENT_SANDBOX_NETWORK_MODE;
  if (!NETWORK_MODES.has(configured as AgentSandboxNetworkMode)) {
    throw new Error(
      "AGENT_SANDBOX_NETWORK_MODE must be isolated, standard, or trusted.",
    );
  }
  return configured as AgentSandboxNetworkMode;
}

export function readAgentSandboxNetworkAllowlist(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] {
  const raw = environment.AGENT_SANDBOX_NETWORK_ALLOWLIST?.trim();
  if (!raw) return [];
  const domains = raw.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (domains.length > MAX_NETWORK_DOMAINS) {
    throw new Error(
      `AGENT_SANDBOX_NETWORK_ALLOWLIST must contain at most ${MAX_NETWORK_DOMAINS} domains.`,
    );
  }
  for (const domain of domains) {
    if (!isValidNetworkDomain(domain)) {
      throw new Error(
        `AGENT_SANDBOX_NETWORK_ALLOWLIST contains an invalid domain ${JSON.stringify(domain)}.`,
      );
    }
  }
  return [...new Set(domains)].sort();
}

function isValidNetworkDomain(domain: string): boolean {
  if (domain.length > 253 || !DOMAIN_PATTERN.test(domain)) return false;
  const labels = domain.startsWith("*.") ? domain.slice(2).split(".") : domain.split(".");
  // Network policies match DNS names, not IPv4 literals. Keeping literals out
  // of the allowlist also avoids making an operator believe a host rule is
  // protected against DNS rebinding; subnet denies remain the IP boundary.
  if (labels.length === 4 && labels.every((label) => /^\d+$/u.test(label))) return false;
  return true;
}

export function resolveAgentSandboxNetworkPolicy(
  mode: AgentSandboxNetworkMode,
  backend: "docker" | "microsandbox" | "vercel",
  allowlist: readonly string[] = [],
): SandboxNetworkPolicy {
  if (mode === "isolated") return "deny-all";
  if (mode === "trusted") return "allow-all";
  if (backend === "docker") {
    throw new Error(
      "AGENT_SANDBOX_NETWORK_MODE=standard requires microsandbox or vercel; Docker only supports allow-all or deny-all.",
    );
  }
  return {
    allow: [...STANDARD_NETWORK_DOMAINS, ...allowlist].filter(
      (domain, index, domains) => domains.indexOf(domain) === index,
    ),
    subnets: { deny: [...STANDARD_NETWORK_DENIED_SUBNETS] },
  };
}

export function resolveAgentDockerNetworkPolicy(
  mode: AgentSandboxNetworkMode,
): "allow-all" | "deny-all" {
  const policy = resolveAgentSandboxNetworkPolicy(mode, "docker");
  if (policy !== "allow-all" && policy !== "deny-all") {
    throw new Error("Docker sandbox network policy must be coarse-grained.");
  }
  return policy;
}
