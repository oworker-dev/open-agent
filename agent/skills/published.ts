import { defineDynamic, defineSkill, type DynamicResolveContext } from "eve/skills";
import {
  agentExtensionCatalogForConfig,
  resolveAgentRunPolicy,
  runtimeExtensionForRef,
} from "../../lib/agent-extension-catalog.ts";
import { readAgentRunPolicy } from "../lib/run-policy.ts";
import { createPostgresAgentExtensionStoreFromEnvironment } from "../../server/data/agent-extension-store.ts";
import { readAgentRuntimeConfig } from "../lib/runtime-config.ts";
import { definePublishedSkill } from "../lib/published-skill.ts";

const SOFTWARE_TASK = {
  id: "software-task",
  version: "1.0.0",
} as const;
const extensionStore = createPostgresAgentExtensionStoreFromEnvironment();

async function resolvePublishedSkills(ctx: DynamicResolveContext) {
  const attributes = ctx.session.auth.current?.attributes;
  const config = readAgentRuntimeConfig(ctx);
  const policy = resolveAgentRunPolicy(
    {
      profileId:
        typeof attributes?.agentProfileId === "string"
          ? attributes.agentProfileId
          : config.profile.id,
      version:
        typeof attributes?.agentProfileVersion === "string"
          ? attributes.agentProfileVersion
          : config.profile.version,
    },
    readAgentRunPolicy(ctx),
    undefined,
    config,
  );
  const tenantId = attributes?.tenantId;
  if (extensionStore && typeof tenantId === "string" && tenantId.trim()) {
    await extensionStore.assertPolicyAllowed(
      tenantId,
      policy,
      agentExtensionCatalogForConfig(config),
    );
  }
  const skills = policy.skills ?? [];
  const resolved = Object.fromEntries(
    skills.flatMap((skill) => {
      const runtimeExtension = runtimeExtensionForRef(config, "skill", skill);
      if (runtimeExtension?.skill) {
        return [[skill.id, definePublishedSkill(runtimeExtension)]];
      }
      if (skill.id === SOFTWARE_TASK.id && skill.version === SOFTWARE_TASK.version) {
        return [["software-task", defineSkill({
          description:
            "Use when implementing, debugging, reviewing, or validating a software change in the workspace.",
          markdown:
            "Inspect the repository instructions and current state before editing. Preserve unrelated changes. Prefer existing project patterns and small, coherent tests and run the narrowest useful validation first, then the broader project checks required by the risk. Report what changed, what was verified, and any remaining uncertainty.",
        })]];
      }
      return [];
    }),
  );
  return Object.keys(resolved).length ? resolved : null;
}

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => resolvePublishedSkills(ctx),
    "turn.started": (_event, ctx) => resolvePublishedSkills(ctx),
  },
});
