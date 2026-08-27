export type CapacityLevelResult = {
  readonly level: number;
  readonly ok: boolean;
  readonly evidencePath: string;
  readonly error?: string;
};

export type MixedCapacityLevel = {
  readonly streams: number;
  readonly runs: number;
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

export function parseMixedCapacityLevels(
  value: string | undefined,
  fallback: readonly MixedCapacityLevel[],
  maximumStreams = 10_000,
  maximumRuns = 100,
): readonly MixedCapacityLevel[] {
  if (!value?.trim()) return fallback.map((level) => ({ ...level }));
  const seen = new Set<string>();
  const parsed: MixedCapacityLevel[] = [];
  for (const entry of value.split(",")) {
    const match = /^(\d+)\s*[:x/]\s*(\d+)$/iu.exec(entry.trim());
    if (!match) continue;
    const streams = Number(match[1]);
    const runs = Number(match[2]);
    if (!Number.isSafeInteger(streams) || !Number.isSafeInteger(runs) || streams < 1 || runs < 1 || streams > maximumStreams || runs > maximumRuns) continue;
    const key = `${streams}:${runs}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parsed.push({ streams, runs });
  }
  if (parsed.length === 0) throw new Error("Mixed capacity levels must contain stream:run positive integer pairs.");
  return parsed;
}
