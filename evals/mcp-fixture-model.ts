import { mockModel, type MockModelRequest } from "eve/evals";

export const MCP_EVAL_FIXTURE = "mcp-conformance-v1";

export function createMcpEvalModel() {
  return mockModel({
    modelId: MCP_EVAL_FIXTURE,
    provider: "open-agent-eval",
    respond(request) {
      const forbiddenCredentialMarkers = [
        process.env.MCP_FIXTURE_BROKER_TOKEN,
        process.env.MCP_FIXTURE_CREDENTIAL,
      ].filter((marker): marker is string => Boolean(marker));
      const visibleModelInput = JSON.stringify({
        messages: request.messages,
        toolResults: request.toolResults,
        tools: request.tools,
      });
      if (forbiddenCredentialMarkers.some((marker) => visibleModelInput.includes(marker))) {
        return "MCP_CREDENTIAL_LEAK_DETECTED";
      }
      const task = request.lastUserMessage ?? "";
      if (task.includes("EVAL_MCP_READ")) return runMcpRead(request);
      if (task.includes("EVAL_MCP_WRITE")) return runMcpWrite(request);
      return "MCP_FIXTURE_UNKNOWN_TASK";
    },
  });
}

function runMcpRead(request: MockModelRequest) {
  const searchId = turnCallId(request, "mcp-read-search");
  const callId = turnCallId(request, "mcp-read-call");
  if (!resultById(request, searchId)) {
    return tool("eve__search", {
      query: "gateway__read_record",
      limit: 10,
    }, searchId);
  }
  const search = resultById(request, searchId);
  if (search?.isError) return "MCP_READ_SEARCH_FAILED";
  const results = search?.output && typeof search.output === "object" && "results" in search.output
    ? (search.output as { results?: unknown }).results
    : undefined;
  if (!Array.isArray(results)) return "MCP_READ_TOOL_NOT_DISCOVERED";
  if (!results.some((candidate) => isDiscoveredTool(candidate, "gateway__read_record"))) {
    return "MCP_READ_TOOL_NOT_DISCOVERED";
  }
  if (results.some((candidate) => isDiscoveredTool(candidate, "gateway__hidden_delete"))) {
    return "MCP_HIDDEN_TOOL_DISCOVERED";
  }
  if (!request.tools.some((candidate) => candidate.name === "eve__tool")) return "MCP_READ_TOOL_NOT_DISCOVERED";
  if (!resultById(request, callId)) {
    return tool("eve__tool", { name: "gateway__read_record", input: { key: "alpha" } }, callId);
  }
  return resultById(request, callId)?.isError
    ? "MCP_READ_FAILED"
    : "MCP_READ_COMPLETED";
}

function runMcpWrite(request: MockModelRequest) {
  const searchId = turnCallId(request, "mcp-write-search");
  const callId = turnCallId(request, "mcp-write-call");
  if (!resultById(request, searchId)) {
    return tool("eve__search", {
      query: "gateway__write_record",
      limit: 10,
    }, searchId);
  }
  const search = resultById(request, searchId);
  if (search?.isError) return "MCP_WRITE_SEARCH_FAILED";
  const results = search?.output && typeof search.output === "object" && "results" in search.output
    ? (search.output as { results?: unknown }).results
    : undefined;
  if (!Array.isArray(results) || !results.some((candidate) => isDiscoveredTool(candidate, "gateway__write_record"))) {
    return "MCP_WRITE_TOOL_NOT_DISCOVERED";
  }
  if (!request.tools.some((candidate) => candidate.name === "eve__tool")) return "MCP_WRITE_TOOL_NOT_DISCOVERED";
  const writeTool = request.tools.find((candidate) => candidate.name.endsWith("__write_record"));
  if (!resultById(request, callId)) {
    return tool("eve__tool", { name: "gateway__write_record", input: { key: "alpha", value: "updated" } }, callId);
  }
  return resultById(request, callId)?.isError
    ? "MCP_WRITE_BLOCKED"
    : "MCP_WRITE_COMPLETED";
}

function isDiscoveredTool(candidate: unknown, name: string): boolean {
  return Boolean(candidate && typeof candidate === "object" && "tool" in candidate && candidate.tool === name);
}

function resultById(request: MockModelRequest, id: string) {
  return request.toolResults.find((item) => item.id === id);
}

function turnCallId(request: MockModelRequest, base: string) {
  return `${base}-${request.userMessageCount}`;
}

function tool(name: string, input: unknown, id: string) {
  return {
    toolCalls: [{ id, input, name }],
    usage: { inputTokens: 100, outputTokens: 10 },
  };
}
