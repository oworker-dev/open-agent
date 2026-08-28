export function compareRecoveredEventSequence(observedEvents, canonicalEvents) {
  const observedIds = observedEvents.map(eventId);
  const canonicalIds = canonicalEvents.map(eventId);
  const violations = [];

  const missingObservedIds = observedIds.filter((id) => id === undefined).length;
  const missingCanonicalIds = canonicalIds.filter((id) => id === undefined).length;
  if (missingObservedIds > 0) {
    violations.push(`${missingObservedIds} recovered events did not contain a stable event id.`);
  }
  if (missingCanonicalIds > 0) {
    violations.push(`${missingCanonicalIds} canonical events did not contain a stable event id.`);
  }

  const observedStableIds = observedIds.filter((id) => id !== undefined);
  const canonicalStableIds = canonicalIds.filter((id) => id !== undefined);
  const observedDuplicates = duplicateCount(observedStableIds);
  const canonicalDuplicates = duplicateCount(canonicalStableIds);
  if (observedDuplicates > 0) {
    violations.push(`${observedDuplicates} duplicate stable event ids appeared after reconnect.`);
  }
  if (canonicalDuplicates > 0) {
    violations.push(`${canonicalDuplicates} duplicate stable event ids appeared in canonical replay.`);
  }

  let firstMismatchIndex;
  const comparedLength = Math.max(observedIds.length, canonicalIds.length);
  for (let index = 0; index < comparedLength; index += 1) {
    if (observedIds[index] !== canonicalIds[index]) {
      firstMismatchIndex = index;
      break;
    }
  }
  if (firstMismatchIndex !== undefined) {
    violations.push(`Recovered event order diverged from canonical replay at index ${firstMismatchIndex}.`);
  }

  return {
    canonicalEventCount: canonicalEvents.length,
    canonicalStableIds: canonicalStableIds.length,
    firstMismatchIndex,
    observedEventCount: observedEvents.length,
    observedStableIds: observedStableIds.length,
    stableIdSequenceMatch: firstMismatchIndex === undefined
      && missingObservedIds === 0
      && missingCanonicalIds === 0
      && observedDuplicates === 0
      && canonicalDuplicates === 0,
    violations,
  };
}

export function eventId(event) {
  const id = event?.meta?.id;
  return typeof id === "string" && id.trim() ? id : undefined;
}

function duplicateCount(values) {
  const seen = new Set();
  let duplicates = 0;
  for (const value of values) {
    if (seen.has(value)) duplicates += 1;
    else seen.add(value);
  }
  return duplicates;
}
