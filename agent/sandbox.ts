import { defineSandbox } from "eve/sandbox";
import {
  readAgentDockerResourceLimits,
  readAgentSandboxAdmissionConfig,
  readAgentSandboxBackend,
  readAgentSandboxIdleTimeoutMs,
  readAgentSandboxImage,
} from "../lib/production-config.ts";
import {
  readAgentSandboxNetworkAllowlist,
  readAgentSandboxNetworkMode,
  resolveAgentDockerNetworkPolicy,
  resolveAgentSandboxNetworkPolicy,
} from "../lib/sandbox-network-policy.ts";
import { ManagedDockerSandbox, DEFAULT_AGENT_SANDBOX_IMAGE } from "./lib/docker-sandbox-provider.ts";
import { ManagedVercelSandbox } from "./lib/vercel-sandbox-provider.ts";

const configured = readAgentSandboxBackend();
// Local auto selection stays isolated. There is deliberately no in-process
// shell fallback when a Docker daemon is unavailable.
const selected = configured === "auto" ? (process.env.VERCEL?.trim() ? "vercel" : "docker") : configured;
const shared = {
  admission: readAgentSandboxAdmissionConfig(),
  idleTimeoutMs: readAgentSandboxIdleTimeoutMs(),
};
const image = readAgentSandboxImage();
const networkMode = readAgentSandboxNetworkMode();
const networkAllowlist = readAgentSandboxNetworkAllowlist();

const provider = selected === "vercel"
  ? { kind: "vercel" as const, environment: ManagedVercelSandbox.environment({ ...shared, ...(image ? { image } : {}) }) }
  : { kind: "docker" as const, environment: ManagedDockerSandbox.environment({ ...shared,
      image: image ?? (process.env.EVE_SANDBOX_IMAGE_TAG?.trim()
        ? `ghcr.io/vercel/eve:${process.env.EVE_SANDBOX_IMAGE_TAG.trim()}` : DEFAULT_AGENT_SANDBOX_IMAGE),
      limits: readAgentDockerResourceLimits(),
    }) };
export const environment = provider.environment;

export default defineSandbox(() => {
  if (provider.kind === "vercel") return provider.environment.open({
    networkPolicy: resolveAgentSandboxNetworkPolicy(networkMode, "vercel", networkAllowlist),
  });
  return provider.environment.open({
    networkPolicy: resolveAgentDockerNetworkPolicy(configured === "auto" && networkMode === "standard" ? "isolated" : networkMode),
  });
});
