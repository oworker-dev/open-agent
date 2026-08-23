export type CapacityLevelResult = {
  readonly level: number;
  readonly ok: boolean;
  readonly evidencePath: string;
  readonly error?: string;
};

export function parseCapacityLevels(
  value: string | undefined,
  fallback: readonly number[],
  maximum = 10_000,
): readonly number[] {
  if (!value?.trim()) return [...fallback];
  const parsed = value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item, index, values) => Number.isSafeInteger(item) && item > 0 && item <= maximum && values.indexOf(item) === index)
    .sort((left, right) => left - right);
  if (parsed.length === 0) throw new Error("Capacity levels must contain positive integers.");
  return parsed;
}

export function highestPassingLevel(results: readonly CapacityLevelResult[]): number | null {
  const passing = results.filter((result) => result.ok).map((result) => result.level);
  return passing.length === 0 ? null : Math.max(...passing);
}
