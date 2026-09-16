/**
 * Host-neutral asset contracts.
 *
 * Asset bytes deliberately do not appear in these request/metadata types. A
 * host may back the store with S3, R2, GCS, or the filesystem development
 * adapter, while Agent messages carry only the stable asset id and metadata.
 */
export function parseAssetPrompt(value) {
    const assets = [];
    let clientMessageId;
    const text = value.replace(/^\[open-agent-(asset|message) (\{[^\n]+?\})\](?: Attached asset [^\n]*?\. Use import_asset before inspecting or processing it\.)?$/gmu, (marker, kind, json) => {
        try {
            const data = JSON.parse(json);
            if (kind === "message" && typeof data.id === "string" && /^[a-zA-Z0-9._:-]{8,200}$/u.test(data.id)) {
                clientMessageId = data.id;
                return "";
            }
            if (kind === "asset" && typeof data.id === "string" && /^[a-zA-Z0-9_-]{1,200}$/u.test(data.id) &&
                typeof data.name === "string" && typeof data.mediaType === "string") {
                assets.push({ id: data.id, name: data.name, mediaType: data.mediaType,
                    ...(Number.isSafeInteger(data.size) && data.size > 0 ? { size: data.size } : {}) });
                return "";
            }
        }
        catch { /* Malformed markers remain ordinary user text. */ }
        return marker;
    }).trim();
    return { text, assets, ...(clientMessageId ? { clientMessageId } : {}) };
}
export function serializeAssetPrompt(text, assets, clientMessageId) {
    return [text, ...assets.map((asset) => `[open-agent-asset ${JSON.stringify(asset)}]`),
        ...(clientMessageId ? [`[open-agent-message ${JSON.stringify({ id: clientMessageId })}]`] : []),
    ].filter(Boolean).join("\n\n");
}
//# sourceMappingURL=asset.js.map