import { Buffer } from "node:buffer";
import { defineSkill } from "eve/skills";
import type { AgentRuntimeExtension } from "@oworker/open-agent-contracts/runtime-config";

/** Convert the JSON-safe host contract into Eve's native Skill package shape. */
export function definePublishedSkill(extension: AgentRuntimeExtension) {
  if (extension.kind !== "skill" || extension.skill === undefined) {
    throw new Error(`Extension ${extension.id}@${extension.version} is not a Skill.`);
  }
  return defineSkill({
    description: extension.description,
    markdown: extension.skill.markdown,
    ...(extension.skill.files
      ? { files: Object.fromEntries(Object.entries(extension.skill.files).map(([path, file]) => [
        path,
        typeof file === "string"
          ? file
          : Buffer.from(file.data, "base64"),
      ])) }
      : {}),
    ...(extension.skill.license
      ? { license: extension.skill.license }
      : {}),
    ...(extension.skill.metadata
      ? { metadata: { ...extension.skill.metadata } }
      : {}),
  });
}
