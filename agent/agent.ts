import { createOpenAI } from "@ai-sdk/openai";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";
import { defineAgent, defineDynamic } from "eve";
import {
  AUTONOMY_EVAL_FIXTURE,
  createAutonomyEvalModel,
} from "../evals/fixture-model";
import {
  readAgentEvalContextWindowTokens,
  readAgentModelMaxOutputTokens,
} from "../lib/agent-profile";
import type { AgentReasoningLevel } from "@oworker/open-agent-contracts/runtime-config";
import {
  findAgentRuntimeModel,
  isAgentReasoningLevelForModel,
  readDeploymentAgentRuntimeConfig,
  resolveAgentRuntimeModel,
  runtimeDefinitionLimits,
} from "../lib/agent-runtime-config";
import { readAgentRuntimeConfig } from "./lib/runtime-config.ts";
import { createProviderFetch } from "../lib/provider-http";
import { providerOutputBudgetMiddleware } from "../lib/provider-output-budget";
import { eveOwnedProviderRetryMiddleware } from "../lib/provider-retry-boundary";
import { assetModelInputMiddleware } from "./lib/asset-model-input.ts";
import { imageRootSession, type ImageContext } from "./lib/image-input.ts";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
  fetch: createProviderFetch(),
});

const deploymentConfig = readDeploymentAgentRuntimeConfig();
const deploymentDefaultModel = resolveAgentRuntimeModel(
  deploymentConfig,
  deploymentConfig.defaultModelId,
);
const workflowWorld = process.env.WORKFLOW_TARGET_WORLD?.trim();
const evalFixtureModel = process.env.AGENT_EVAL_FIXTURE_MODEL === AUTONOMY_EVAL_FIXTURE
  ? createAutonomyEvalModel()
  : undefined;
const evalContextWindowTokens = evalFixtureModel
  ? readAgentEvalContextWindowTokens()
  : deploymentDefaultModel.contextWindowTokens;
const modelMaxOutputTokens = readAgentModelMaxOutputTokens();
const definitionLimits = runtimeDefinitionLimits(deploymentConfig);

function createAgentModel(
  providerModelId: string,
  reasoning?: AgentReasoningLevel,
  maxOutputTokens = modelMaxOutputTokens,
  imageContext?: ImageContext,
) {
  return wrapLanguageModel({
    middleware: [
      defaultSettingsMiddleware({
        settings: {
          providerOptions: {
            openai: {
              ...(reasoning ? { reasoningEffort: reasoning } : {}),
              store: false,
            },
          },
        },
      }),
      providerOutputBudgetMiddleware(Math.min(modelMaxOutputTokens, maxOutputTokens)),
      eveOwnedProviderRetryMiddleware,
      ...(imageContext ? [assetModelInputMiddleware(imageContext)] : []),
    ],
    model: openai(providerModelId),
  });
}

export default defineAgent({
  build: { externalDependencies: ["sharp"] },
  description: "A general-purpose autonomous agent for research, software, and knowledge work.",
  model: defineDynamic({
    fallback: evalFixtureModel ?? createAgentModel(
      deploymentDefaultModel.providerModelId,
      deploymentDefaultModel.defaultReasoning,
      deploymentDefaultModel.maxOutputTokens,
    ),
    events: {
      "step.started": (_event, ctx) => {
        if (evalFixtureModel) {
          return {
            model: evalFixtureModel,
            modelContextWindowTokens: evalContextWindowTokens,
          };
        }
        const config = readAgentRuntimeConfig(ctx);
        const attributes = ctx.session.auth.current?.attributes;
        const requestedModel = attributes?.agentModelId;
        const requestedReasoning = attributes?.agentReasoning;
        const model = findAgentRuntimeModel(config, requestedModel) ??
          resolveAgentRuntimeModel(config, config.defaultModelId);
        const reasoning = isAgentReasoningLevelForModel(model, requestedReasoning)
          ? requestedReasoning
          : model.defaultReasoning;

        return {
          model: createAgentModel(model.providerModelId, reasoning, model.maxOutputTokens, { session: {
            id: ctx.session.id,
            auth: ctx.session.auth,
            parent: { rootSessionId: imageRootSession.get() ?? ctx.session.id },
          } }),
          modelContextWindowTokens: model.contextWindowTokens,
          modelOptions: {
            providerOptions: {
              openai: {
                reasoningEffort: reasoning,
                // Eve owns durable history, so never depend on provider-side item storage.
                store: false,
              },
            },
          },
        };
      },
    },
  }),
  modelContextWindowTokens: evalContextWindowTokens,
  modelOptions: {
    providerOptions: {
      openai: { store: false },
    },
  },
  reasoning: "provider-default",
  compaction: {
    thresholdPercent: deploymentConfig.compaction.thresholdPercent,
  },
  limits: {
    ...definitionLimits,
  },
  experimental: {
    subagentPersistentSessions: true,
    ...(workflowWorld ? { workflow: { world: workflowWorld } } : {}),
  },
});
