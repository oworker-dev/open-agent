import type { AgentExtensionRef, AgentRunLimits, JsonValue } from "./agent-run.js";
export declare const AGENT_RUNTIME_CONFIG_CONTRACT_VERSION: "0.1.0";
export declare const AGENT_REASONING_LEVELS: readonly ["low", "medium", "high", "xhigh"];
export type AgentReasoningLevel = (typeof AGENT_REASONING_LEVELS)[number];
export type AgentRuntimeModel = {
    readonly id: string;
    readonly providerModelId: string;
    readonly label: string;
    readonly contextWindowTokens: number;
    readonly maxOutputTokens: number;
    readonly reasoningLevels: readonly AgentReasoningLevel[];
    readonly defaultReasoning: AgentReasoningLevel;
};
/**
 * Framework session limits published by a host. Token lifetime limits may be
 * explicitly disabled with `false`; this maps directly to Eve's
 * uncapped-session semantics and is distinct from an omitted field.
 */
export type AgentRuntimeLimits = Omit<AgentRunLimits, "maxInputTokens" | "maxOutputTokens"> & {
    readonly maxInputTokens?: number | false;
    readonly maxOutputTokens?: number | false;
};
export type AgentRuntimeProfile = {
    readonly id: string;
    readonly version: string;
    readonly label: string;
    readonly outputMode: "json" | "text";
    readonly instructions?: string;
    readonly allowedSkills: readonly AgentExtensionRef[];
    readonly defaultSkills: readonly AgentExtensionRef[];
    readonly allowedMcpConnections: readonly AgentExtensionRef[];
    readonly defaultMcpConnections: readonly AgentExtensionRef[];
};
/**
 * Host-published extension metadata. Skill content is procedure text only;
 * credentials and opaque provider secrets are never valid in this contract.
 */
export type AgentRuntimeExtension = AgentExtensionRef & {
    readonly kind: "mcp" | "skill";
    readonly label: string;
    readonly description: string;
    readonly skill?: {
        readonly markdown: string;
    };
    readonly mcp?: {
        readonly endpoint: string;
        readonly authProvider?: string;
    };
};
/**
 * A credential-free, versioned execution snapshot supplied by the standalone
 * deployment or an authenticated integrator. Existing durable sessions pin the
 * exact snapshot; changing a Host default never mutates an active session.
 */
export type AgentRuntimeConfigSnapshot = {
    readonly contractVersion: typeof AGENT_RUNTIME_CONFIG_CONTRACT_VERSION;
    readonly id: string;
    readonly version: string;
    readonly defaultModelId: string;
    readonly models: readonly AgentRuntimeModel[];
    readonly profile: AgentRuntimeProfile;
    readonly compaction: {
        readonly thresholdPercent: number;
    };
    readonly limits: AgentRuntimeLimits;
    readonly extensions?: readonly AgentRuntimeExtension[];
    readonly metadata?: Readonly<Record<string, JsonValue>>;
};
export declare function parseAgentRuntimeConfigSnapshot(value: unknown): AgentRuntimeConfigSnapshot;
//# sourceMappingURL=runtime-config.d.ts.map