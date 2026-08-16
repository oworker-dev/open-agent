import { defineTool } from "eve/tools";
import { z } from "zod";
import { readRemoteBytes, safeRemoteFetch } from "../lib/safe-remote-fetch.ts";

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
const MAX_TEXT_OUTPUT = 50 * 1024;
const TEXT_CONTENT_TYPES = /^(text\/|application\/(json|ld\+json|javascript|xml|xhtml\+xml|yaml|toml|csv|graphql))/i;

const inputSchema = z.strictObject({
  format: z.enum(["markdown", "text", "html"]).optional(),
  timeout: z.number().optional(),
  url: z.string().url(),
});

const outputSchema = z.object({
  binary: z.boolean(),
  byteLength: z.number(),
  content: z.string(),
  contentType: z.string(),
  truncated: z.boolean(),
  url: z.string(),
});

/**
 * Keep the public web_fetch contract while preventing binary responses from
 * being decoded into model-visible text. Rich binary inspection belongs to a
 * typed asset/view tool, not a generic HTTP text fetch.
 */
export default defineTool({
  description: [
    "Fetch a URL and return bounded textual content.",
    "Binary responses such as images, video, audio, PDFs, and archives are never decoded into text; only metadata is returned.",
    "Use a workspace asset or a dedicated image inspection capability when the bytes themselves are needed.",
  ].join(" "),
  inputSchema,
  outputSchema,
  async execute(input, ctx) {
    const timeoutMs = Math.min(Math.max((input.timeout ?? 30) * 1000, 1_000), 120_000);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = ctx.abortSignal ? AbortSignal.any([ctx.abortSignal, timeoutSignal]) : timeoutSignal;
    const { response, url } = await safeRemoteFetch(input.url, {
      headers: {
        Accept: input.format === "html"
          ? "text/html, application/xhtml+xml, text/plain;q=0.8, */*;q=0.1"
          : "text/markdown, text/plain, text/html, application/json, application/xml;q=0.8, */*;q=0.1",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": "open-agent/web-fetch",
      },
      signal,
    });
    const finalUrl = url;
    if (!response.ok) throw new Error(`Request failed with status code: ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_RESPONSE_SIZE) throw new Error("Response exceeds the 5 MB limit.");
    const bytes = await readRemoteBytes(response, MAX_RESPONSE_SIZE);
    const binary = !TEXT_CONTENT_TYPES.test(contentType) && !contentType.toLowerCase().includes("text/html");
    if (binary) {
      return {
        binary: true,
        byteLength: bytes.byteLength,
        content: "",
        contentType,
        truncated: false,
        url: finalUrl,
      };
    }
    const decoded = new TextDecoder().decode(bytes);
    const truncated = decoded.length > MAX_TEXT_OUTPUT;
    return {
      binary: false,
      byteLength: bytes.byteLength,
      content: truncated ? decoded.slice(0, MAX_TEXT_OUTPUT) : decoded,
      contentType,
      truncated,
      url: finalUrl,
    };
  },
  toModelOutput(output) {
    if (output.binary) {
      return {
        type: "text",
        value: `Fetched binary resource (${output.contentType}, ${output.byteLength} bytes) from ${output.url}. No binary bytes were added to the text context.`,
      };
    }
    return {
      type: "text",
      value: output.content || `Fetched an empty response from ${output.url}.`,
    };
  },
});
