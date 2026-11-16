"use client";

import { createContext } from "react";
import type { AgentSubagentSummary } from "./contracts.js";

export const AgentSubagentsContext = createContext<readonly AgentSubagentSummary[]>([]);
