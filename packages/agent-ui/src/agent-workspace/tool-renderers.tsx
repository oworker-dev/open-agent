"use client";

import { createContext, type ComponentType, type ReactNode } from "react";
import type { SessionStreamEvent } from "eve/client";
import type { Answer } from "eve/events";
import type { EveToolPart } from "eve/react";
import type { AgentSessionDeliverable } from "./contracts.js";
import type { AgentLocale } from "./i18n.js";

/** The same projected part used by the default UI, including live input/output. */
export type AgentToolRendererProps = {
  readonly part: EveToolPart;
  readonly events: readonly SessionStreamEvent[];
  readonly locale: AgentLocale;
  readonly canRespond: boolean;
  readonly inputRequestClosed: boolean;
  readonly assetUrl?: (assetId: string) => string;
  readonly onInputResponses: (responses: readonly Answer[]) => void | Promise<void>;
  readonly onCloseInputRequest: (requestId: string) => void;
  readonly onOpenSubagent?: (sessionId: string) => void;
  readonly onOpenDeliverable?: (deliverable: AgentSessionDeliverable) => void;
  /** Return this node to retain the complete default tool/interaction UI. */
  readonly defaultContent: ReactNode;
};

/** Exact tool names, including namespaces. Missing entries retain the default UI. */
export type AgentToolRenderers = Readonly<Record<string, ComponentType<AgentToolRendererProps> | undefined>>;

export const AgentToolRenderersContext = createContext<AgentToolRenderers | undefined>(undefined);
