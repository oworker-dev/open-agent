export const MAX_PUBLICATION_ALIAS_LENGTH = 160;
export const MAX_PUBLICATION_VERSION_LENGTH = 80;

export type PublicationMetadata = {
  readonly alias?: string;
  readonly version?: string;
};

export function normalizePublicationMetadata(input: PublicationMetadata): PublicationMetadata {
  return {
    ...(input.alias !== undefined ? { alias: normalizeValue(input.alias, "alias", MAX_PUBLICATION_ALIAS_LENGTH) } : {}),
    ...(input.version !== undefined ? { version: normalizeValue(input.version, "version", MAX_PUBLICATION_VERSION_LENGTH) } : {}),
  };
}

function normalizeValue(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`Publication ${field} is invalid.`);
  }
  return normalized;
}
