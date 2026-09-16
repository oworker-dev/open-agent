export function summarizeUsage(events) {
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let contextInputTokens = 0;
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let steps = 0;
    let lastCompletedStepIndex = -1;
    for (const [eventIndex, event] of events.entries()) {
        if (event.type !== "step.completed" || !event.data.usage)
            continue;
        const usage = event.data.usage;
        cacheReadTokens += usage.cacheReadTokens ?? 0;
        cacheWriteTokens += usage.cacheWriteTokens ?? 0;
        contextInputTokens = usage.inputTokens ?? contextInputTokens;
        costUsd += usage.costUsd ?? 0;
        inputTokens += usage.inputTokens ?? 0;
        outputTokens += usage.outputTokens ?? 0;
        steps += 1;
        lastCompletedStepIndex = eventIndex;
    }
    const pending = estimatePendingTokens(events.slice(lastCompletedStepIndex + 1));
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
    let actionCharacters = 0;
    for (const event of events) {
        if (event.type === "message.appended") {
            const key = `message:${event.data.turnId}:${event.data.stepIndex}`;
            cumulativeText.set(key, event.data.messageSoFar ?? (cumulativeText.get(key) ?? "") + event.data.messageDelta);
        }
        else if (event.type === "reasoning.appended") {
            const key = `reasoning:${event.data.turnId}:${event.data.stepIndex}`;
            cumulativeText.set(key, event.data.reasoningSoFar ?? (cumulativeText.get(key) ?? "") + event.data.reasoningDelta);
        }
        else if (event.type === "message.completed") {
            cumulativeText.set(`message:${event.data.turnId}:${event.data.stepIndex}`, event.data.message ?? "");
        }
        else if (event.type === "reasoning.completed") {
            cumulativeText.set(`reasoning:${event.data.turnId}:${event.data.stepIndex}`, event.data.reasoning);
        }
        else if (event.type === "message.received") {
            contextCharacters += event.data.message.length;
        }
        else if (event.type === "action.result") {
            const length = safeModelVisibleLength(event.data.result.output);
            actionCharacters = Math.min(actionCharacters + length, 100_000);
        }
    }
    let outputCharacters = 0;
    for (const value of cumulativeText.values())
        outputCharacters += value.length;
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