export function summarizeUsage(events) {
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let contextInputTokens = 0;
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let steps = 0;
    let lastUsageIndex = -1;
    for (const [eventIndex, event] of events.entries()) {
        if (event.type !== "usage.recorded")
            continue;
        const usage = event.data.usage;
        cacheReadTokens += usage.cacheReadTokens ?? 0;
        cacheWriteTokens += usage.cacheWriteTokens ?? 0;
        contextInputTokens = usage.inputTokens ?? contextInputTokens;
        costUsd += usage.costUsd ?? 0;
        inputTokens += usage.inputTokens ?? 0;
        outputTokens += usage.outputTokens ?? 0;
        steps += 1;
        lastUsageIndex = eventIndex;
    }
    const pending = estimatePendingTokens(events.slice(lastUsageIndex + 1));
    contextInputTokens += pending.context;
    outputTokens += pending.output;
    return {
        cacheReadTokens,
        cacheWriteTokens,
        contextInputTokens,
        costUsd,
        inputTokens,
        isEstimated: pending.context > 0,
        outputTokens,
        steps,
    };
}
function estimatePendingTokens(events) {
    const cumulativeText = new Map();
    let contextCharacters = 0;
    const callOutputs = new Map();
    for (const event of events) {
        if (event.type === "content.delta" && (event.data.kind === "text" || event.data.kind === "reasoning")) {
            const key = `${event.data.kind}:${event.data.partId}`;
            cumulativeText.set(key, (cumulativeText.get(key) ?? "") + event.data.delta);
        }
        else if (event.type === "content.completed" && (event.data.kind === "text" || event.data.kind === "reasoning")) {
            cumulativeText.set(`${event.data.kind}:${event.data.partId}`, typeof event.data.value === "string" ? event.data.value : "");
        }
        else if (event.type === "delivery.consumed") {
            contextCharacters += event.data.parts.reduce((total, part) => total + (part.kind === "text" ? part.text.length : 0), 0);
        }
        else if (event.type === "call.progress") {
            callOutputs.set(event.data.callId, event.data.output);
        }
        else if (event.type === "call.settled" && event.data.output !== undefined) {
            callOutputs.set(event.data.callId, event.data.output);
        }
    }
    let outputCharacters = 0;
    for (const value of cumulativeText.values())
        outputCharacters += value.length;
    const actionCharacters = [...callOutputs.values()].reduce((total, output) => Math.min(total + safeModelVisibleLength(output), 100_000), 0);
    return {
        context: Math.ceil((contextCharacters + actionCharacters + outputCharacters) / 4),
        output: Math.ceil(outputCharacters / 4),
    };
}
function safeModelVisibleLength(value) {
    if (isBinaryToolOutput(value))
        return 0;
    if (typeof value === "string")
        return Math.min(value.length, 12_000);
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const record = value;
        for (const key of ["content", "stdout", "stderr", "text", "message"]) {
            if (typeof record[key] === "string")
                return Math.min(record[key].length, 12_000);
        }
    }
    try {
        return Math.min(JSON.stringify(value)?.length ?? 0, 12_000);
    }
    catch {
        return 0;
    }
}
function isBinaryToolOutput(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const record = value;
    return record.binary === true && typeof record.contentType === "string";
}
export function formatTokenCount(value) {
    if (value >= 1_000_000)
        return `${(value / 1_000_000).toFixed(1)}m`;
    if (value >= 1_000)
        return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
    return String(value);
}
//# sourceMappingURL=usage.js.map