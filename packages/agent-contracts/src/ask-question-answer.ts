const MULTI_SELECT_ANSWER_PREFIX = "open-agent:ask-question-multi:v1:";

export type MultiSelectAnswer = {
  readonly optionIds: readonly string[];
  readonly additionalText: string;
};

export function encodeMultiSelectAnswer(answer: MultiSelectAnswer): string {
  return `${MULTI_SELECT_ANSWER_PREFIX}${JSON.stringify({
    additionalText: answer.additionalText.trim(),
    optionIds: [...new Set(answer.optionIds)],
  })}`;
}

export function parseMultiSelectAnswer(value: string): MultiSelectAnswer | undefined {
  if (!value.startsWith(MULTI_SELECT_ANSWER_PREFIX)) return undefined;
  try {
    const parsed: unknown = JSON.parse(value.slice(MULTI_SELECT_ANSWER_PREFIX.length));
    if (!isRecord(parsed)) return undefined;
    if (!Array.isArray(parsed.optionIds) || !parsed.optionIds.every((id) => typeof id === "string")) return undefined;
    if (new Set(parsed.optionIds).size !== parsed.optionIds.length) return undefined;
    if (typeof parsed.additionalText !== "string") return undefined;
    if (Object.keys(parsed).some((key) => key !== "optionIds" && key !== "additionalText")) return undefined;
    return { additionalText: parsed.additionalText, optionIds: parsed.optionIds };
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
