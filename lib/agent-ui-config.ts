import type {
  AgentExtensionInfo,
  AgentPromptMenuItem,
  AgentThreadPreferences,
} from "@oworker/open-agent-ui";
import {
  DEFAULT_AGENT_RUNTIME_CONFIG,
  findAgentRuntimeModel,
  type AgentRuntimeConfigSnapshot,
} from "./agent-runtime-config.ts";

export function createAgentUiConfig(config: AgentRuntimeConfigSnapshot = DEFAULT_AGENT_RUNTIME_CONFIG) {
  const modelOptions = config.models.map(({
    contextWindowTokens,
    defaultReasoning,
    id,
    label,
    reasoningLevels,
  }) => ({
    contextWindowTokens,
    defaultReasoning,
    id,
    label,
    reasoningLevels,
  }));
  const defaultModel = findAgentRuntimeModel(config, config.defaultModelId) ?? config.models[0]!;
  const reasoningLevels = [...new Set(config.models.flatMap((model) => model.reasoningLevels))];
  const skills = config.profile.allowedSkills.map((extension) => {
    const published = config.extensions?.find(
      (candidate) =>
        candidate.kind === "skill" &&
        candidate.id === extension.id &&
        candidate.version === extension.version,
    );
    return {
      ...extension,
      label: published?.label ?? extension.id,
      description: published?.description ?? `Published ${extension.id} skill.`,
    };
  });
  return {
    models: modelOptions,
    reasoningLevels,
    defaultPreferences: {
      modelId: defaultModel.id,
      reasoning: defaultModel.defaultReasoning,
    },
    commands: skills.map((skill) => ({
      id: skill.id,
      label: skill.label,
      value: `/${skill.id}`,
      description: skill.description,
      keywords: ["skill"],
    })),
    extensions: skills.map((skill) => ({
      id: skill.id,
      kind: "skill" as const,
      label: skill.label,
      status: "available" as const,
      version: skill.version,
      description: skill.description,
    })),
  } as const;
}

const DEFAULT_UI_CONFIG = createAgentUiConfig();

export const AGENT_UI_MODELS = DEFAULT_UI_CONFIG.models;

export const AGENT_UI_REASONING_LEVELS: readonly string[] = DEFAULT_UI_CONFIG.reasoningLevels;

export const AGENT_UI_DEFAULT_PREFERENCES: AgentThreadPreferences = DEFAULT_UI_CONFIG.defaultPreferences;

export const AGENT_UI_COMMANDS: readonly AgentPromptMenuItem[] = DEFAULT_UI_CONFIG.commands;

export const AGENT_UI_MENTIONS: readonly AgentPromptMenuItem[] = [
  {
    id: "workspace",
    label: "Workspace context",
    value: "@workspace",
    description: "Reference files and tools in this session sandbox.",
    keywords: ["files", "sandbox", "project"],
    translations: {
      "zh-CN": {
        description: "引用当前会话沙盒中的文件和工具。",
        label: "工作区上下文",
      },
    },
  },
];

export const AGENT_UI_EXTENSIONS: readonly AgentExtensionInfo[] = DEFAULT_UI_CONFIG.extensions;
