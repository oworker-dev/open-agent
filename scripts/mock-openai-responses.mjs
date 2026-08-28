import http from "node:http";

const port = Number(process.env.MOCK_OPENAI_PORT || 4291);
const deploymentId = process.env.MOCK_MUSES_DEPLOYMENT_ID || "";
const workflowInputId = process.env.MOCK_MUSES_WORKFLOW_INPUT_ID || "prompt";
let responseSequence = 0;
let requestCount = 0;
const scenarioAttempts = new Map();

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/v1/models") {
    return sendJson(response, {
      object: "list",
      data: [{ id: "gpt-5.6-sol", object: "model" }],
    });
  }
  if (request.method === "GET" && request.url === "/debug/state") {
    return sendJson(response, {
      requestCount,
      scenarioAttempts: Object.fromEntries(scenarioAttempts),
    });
  }
  if (request.method !== "POST" || request.url !== "/v1/responses") {
    response.writeHead(404).end();
    return;
  }

  requestCount += 1;
  const body = await readJson(request);
  if (injectFailure(response, body)) return;
  const planned = await planResponse(body);
  if (body.stream === true) return sendStream(response, planned);
  return sendJson(response, responseResult(planned));
});

function injectFailure(response, body) {
  const raw = JSON.stringify(body);
  const transient = [
    ["PROVIDER_429_RECOVER", 429, "rate_limit_exceeded"],
    ["PROVIDER_500_RECOVER", 500, "internal_server_error"],
    ["PROVIDER_408_RECOVER", 408, "timeout_error"],
  ];
  for (const [marker, status, type] of transient) {
    if (!raw.includes(marker)) continue;
    const attempt = recordScenarioAttempt(marker);
    if (attempt <= 2) {
      sendProviderError(response, status, type, `${marker} injected attempt ${attempt}.`);
      return true;
    }
    return false;
  }

  if (raw.includes("PROVIDER_STALL_ONCE")) {
    const attempt = recordScenarioAttempt("PROVIDER_STALL_ONCE");
    if (attempt === 1) {
      const delayMs = Number(process.env.MOCK_PROVIDER_STALL_MS || 2_500);
      setTimeout(() => {
        if (!response.destroyed) sendJson(response, responseResult({ kind: "text", text: "STALE" }));
      }, delayMs);
      return true;
    }
    return false;
  }

  if (raw.includes("PROVIDER_STALL_THREE")) {
    const attempt = recordScenarioAttempt("PROVIDER_STALL_THREE");
    if (attempt <= 3) {
      const delayMs = Number(process.env.MOCK_PROVIDER_STALL_MS || 2_500);
      setTimeout(() => {
        if (!response.destroyed) sendJson(response, responseResult({ kind: "text", text: "STALE" }));
      }, delayMs);
      return true;
    }
    return false;
  }

  if (raw.includes("PROVIDER_STREAM_INTERRUPT_ONCE")) {
    const attempt = recordScenarioAttempt("PROVIDER_STREAM_INTERRUPT_ONCE");
    if (attempt === 1) {
      sendInterruptedStream(response);
      return true;
    }
  }
  return false;
}

function recordScenarioAttempt(marker) {
  const attempt = (scenarioAttempts.get(marker) || 0) + 1;
  scenarioAttempts.set(marker, attempt);
  return attempt;
}

function sendProviderError(response, status, type, message) {
  response.writeHead(status, {
    "content-type": "application/json",
    "retry-after": "0",
  });
  response.end(JSON.stringify({ error: { message, type } }));
}

function sendInterruptedStream(response) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const id = `resp_mock_${++responseSequence}`;
  const itemId = `item_interrupted_${responseSequence}`;
  emit(response, "response.created", {
    type: "response.created",
    response: {
      id,
      created_at: Math.floor(Date.now() / 1000),
      model: "gpt-5.6-sol",
      service_tier: "default",
    },
  });
  emit(response, "response.output_item.added", {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "message", id: itemId, phase: "final_answer" },
  });
  emit(response, "response.output_text.delta", {
    type: "response.output_text.delta",
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    delta: "PARTIAL_BEFORE_INTERRUPT",
  });
  setTimeout(() => response.destroy(), 20);
}

server.listen(port, "127.0.0.1", () => {
  console.log(`mock OpenAI Responses provider listening on ${port}`);
});

async function planResponse(body) {
  const input = Array.isArray(body.input) ? body.input : [];
  const raw = JSON.stringify(body);
  if (raw.includes("SANDBOX_LIFECYCLE_E2E")) {
    const bashCalls = input.filter(
      (item) => item?.type === "function_call" && item.name === "bash",
    );
    if (bashCalls.length === 0) {
      return toolCall("bash", {
        command: "printf 'sandbox lifecycle verified\\n' > /workspace/lifecycle.txt && cat /workspace/lifecycle.txt",
      });
    }
    return { kind: "text", text: exactReply(input) || "SANDBOX_LIFECYCLE_READY" };
  }
  if (hasJsonSchema(body) || hasFinalOutputTool(body)) {
    return toolCall("final_output", { answer: "STRUCTURED_READY" });
  }
  if (raw.includes("WAIT_FOR_CANCEL") || raw.includes("SLOW Keep this turn active")) {
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    return { kind: "text", text: "TOO_LATE" };
  }
  if (raw.includes("MUSES_IMAGE_E2E")) {
    return planMusesImageResponse(input);
  }
  if (!raw.includes("MUSES_HOST_E2E")) {
    if (raw.includes("BRIDGE_READY")) return { kind: "text", text: "BRIDGE_READY" };
    return { kind: "text", text: exactReply(input) || "HEADLESS_READY" };
  }
  if (!deploymentId) throw new Error("MOCK_MUSES_DEPLOYMENT_ID is required for MUSES_HOST_E2E.");

  const calls = input.filter((item) => item?.type === "function_call");
  const called = calls.map((item) => ({
    callId: item.call_id,
    name: item.name,
    arguments: parseJson(item.arguments),
  }));
  const hostCapabilitiesCalled = called.some(({ name }) => name === "host_capabilities");
  const invokedCapabilities = called
    .filter(({ name }) => name === "host_invoke")
    .map(({ arguments: args }) => args?.capability);

  if (!hostCapabilitiesCalled) return toolCall("host_capabilities", {});
  if (!invokedCapabilities.includes("canvas.inspect")) {
    return hostInvoke("canvas.inspect", {});
  }
  if (!invokedCapabilities.includes("workflow.invoke")) {
    return hostInvoke("workflow.invoke", {
      deploymentId,
      inputs: {
        [workflowInputId]: { valueType: "text", value: "Return the word BRIDGE_READY." },
      },
    });
  }

  const workflowRunId = deepFind(
    toolOutputs(input, called, "workflow.invoke"),
    (key, value) => key === "runId" && typeof value === "string" && value.startsWith("wrun_"),
  );
  if (!workflowRunId) return { kind: "text", text: "MUSES_HOST_E2E_FAILED: missing Workflow run id" };

  const inspections = toolOutputs(input, called, "workflow.run.wait");
  const completed = inspections.some(
    (output) => deepFind(output, (key, value) => key === "status" && value === "completed") === "completed",
  );
  const failed = inspections.some((output) =>
    ["failed", "cancelled"].includes(
      deepFind(output, (key, value) => key === "status" && typeof value === "string"),
    ),
  );
  if (failed) return { kind: "text", text: `MUSES_HOST_E2E_FAILED ${workflowRunId}` };
  if (!completed) {
    if (inspections.length > 0) await new Promise((resolve) => setTimeout(resolve, 500));
    return hostInvoke("workflow.run.wait", { runId: workflowRunId, timeoutMs: 25_000 });
  }

  const canvasPuts = toolOutputs(input, called, "canvas.item.put");
  const canvasPutCompleted = canvasPuts.some((output) =>
    deepFind(output, (key, value) => key === "revision" && typeof value === "number") !== undefined,
  );
  if (!canvasPutCompleted) {
    return hostInvoke("canvas.item.put", {
      refId: workflowRunId,
      kind: "workflow",
      title: "Verified Agent workflow run",
      x: 120,
      y: 120,
      width: 360,
      height: 180,
    });
  }
  const canvasInspections = invokedCapabilities.filter((name) => name === "canvas.inspect").length;
  if (canvasInspections < 2) return hostInvoke("canvas.inspect", {});
  const finalCanvas = toolOutputs(input, called, "canvas.inspect").at(-1);
  const placedRun = deepFind(
    finalCanvas,
    (key, value) => key === "refId" && value === workflowRunId,
  );
  if (placedRun !== workflowRunId) {
    return { kind: "text", text: `MUSES_HOST_E2E_FAILED: canvas verification ${workflowRunId}` };
  }
  return {
    kind: "text",
    text: `MUSES_HOST_E2E_COMPLETED ${workflowRunId}`,
  };
}

function planMusesImageResponse(input) {
  const calls = input.filter((item) => item?.type === "function_call");
  const called = calls.map((item) => ({
    callId: item.call_id,
    name: item.name,
    arguments: parseJson(item.arguments),
  }));
  const hostCapabilitiesCalled = called.some(({ name }) => name === "host_capabilities");
  const invokedCapabilities = called
    .filter(({ name }) => name === "host_invoke")
    .map(({ arguments: args }) => args?.capability);

  if (!hostCapabilitiesCalled) return toolCall("host_capabilities", {});
  if (!invokedCapabilities.includes("image.generate")) {
    return hostInvoke("image.generate", {
      prompt: "A precise editorial still life of a cobalt glass vase and one red tulip on a white table, soft daylight, clean commercial photography",
      title: "Agent first image verification",
      aspectRatio: "4:3",
      resolution: "1k",
      quality: "low",
    });
  }

  if (!invokedCapabilities.includes("canvas.inspect")) {
    return hostInvoke("canvas.inspect", {});
  }
  return {
    kind: "text",
    text: "MUSES_IMAGE_E2E_COMPLETED",
  };
}

function hasJsonSchema(body) {
  const format = body?.text?.format ?? body?.response_format ?? body?.output_format;
  return format?.type === "json_schema"
    || format?.type === "json_object"
    || JSON.stringify(body).includes('"json_schema"')
    || JSON.stringify(body).includes('"json_object"');
}

function hasFinalOutputTool(body) {
  return Array.isArray(body?.tools)
    && body.tools.some((tool) => tool?.name === "final_output");
}

function exactReply(input) {
  const matches = [];
  visitStrings(input, (value) => {
    const match = value.match(/\b(?:now\s+)?reply(?:\s+with)?\s+exactly:\s*(.+?)\s*$/i);
    if (match?.[1]) matches.push(match[1]);
  });
  return matches.at(-1);
}

function visitStrings(value, visit) {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visitStrings(item, visit);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const item of Object.values(value)) visitStrings(item, visit);
}

function hostInvoke(capability, input) {
  return toolCall("host_invoke", { capability, input });
}

function toolCall(name, args) {
  return {
    kind: "tool",
    name,
    arguments: JSON.stringify(args),
    callId: `call_mock_${++responseSequence}`,
  };
}

function toolOutputs(input, calls, capability) {
  const callIds = new Set(
    calls
      .filter(({ name, arguments: args }) => name === "host_invoke" && args?.capability === capability)
      .map(({ callId }) => callId),
  );
  return input
    .filter((item) => item?.type === "function_call_output" && callIds.has(item.call_id))
    .map((item) => parseJsonOutput(item.output));
}

function parseJsonOutput(value) {
  if (Array.isArray(value)) return value.map(parseJsonOutput);
  const parsed = parseJson(value);
  if (parsed !== undefined) return parsed;
  return value;
}

function parseJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function deepFind(value, predicate) {
  if (typeof value === "string") {
    const parsed = parseJson(value);
    return parsed === undefined || parsed === value
      ? undefined
      : deepFind(parsed, predicate);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFind(item, predicate);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (predicate(key, item)) return item;
    const found = deepFind(item, predicate);
    if (found !== undefined) return found;
  }
  return undefined;
}

function sendStream(response, planned) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const id = `resp_mock_${++responseSequence}`;
  const createdAt = Math.floor(Date.now() / 1000);
  emit(response, "response.created", {
    type: "response.created",
    response: { id, created_at: createdAt, model: "gpt-5.6-sol", service_tier: "default" },
  });
  if (planned.kind === "tool") {
    const itemId = `item_${planned.callId}`;
    const item = {
      type: "function_call",
      id: itemId,
      call_id: planned.callId,
      name: planned.name,
      arguments: planned.arguments,
    };
    emit(response, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, arguments: "" },
    });
    emit(response, "response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      item_id: itemId,
      output_index: 0,
      delta: planned.arguments,
    });
    emit(response, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item: { ...item, status: "completed" },
    });
  } else {
    const itemId = `item_text_${responseSequence}`;
    emit(response, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: itemId, phase: "final_answer" },
    });
    emit(response, "response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: planned.text,
    });
    emit(response, "response.output_text.done", {
      type: "response.output_text.done",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text: planned.text,
    });
    emit(response, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: itemId, phase: "final_answer" },
    });
  }
  emit(response, "response.completed", {
    type: "response.completed",
    response: responseResult(planned, id, createdAt),
  });
  response.end();
}

function responseResult(planned, id = `resp_mock_${++responseSequence}`, createdAt = Math.floor(Date.now() / 1000)) {
  const output = planned.kind === "tool"
    ? [{ type: "function_call", id: `item_${planned.callId}`, call_id: planned.callId, name: planned.name, arguments: planned.arguments, status: "completed" }]
    : [{ type: "message", id: `item_text_${responseSequence}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: planned.text, annotations: [] }] }];
  return {
    id,
    object: "response",
    created_at: createdAt,
    model: "gpt-5.6-sol",
    status: "completed",
    service_tier: "default",
    incomplete_details: null,
    output,
    usage: {
      input_tokens: 23,
      output_tokens: 7,
      total_tokens: 30,
      input_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
      output_tokens_details: { reasoning_tokens: 1 },
    },
  };
}

function emit(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sendJson(response, value) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolve(parseJson(body) || {}));
  });
}
