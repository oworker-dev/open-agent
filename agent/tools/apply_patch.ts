import { defineTool } from "eve/tools";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";
import { randomUUID } from "node:crypto";

export type FileChange = {
  readonly addedLines: number;
  readonly deletedLines: number;
  readonly kind: "add" | "update" | "delete" | "move";
  readonly path: string;
};

export type PatchHunk = {
  readonly oldStart?: number;
  readonly oldCount?: number;
  readonly newStart?: number;
  readonly newCount?: number;
  readonly lines: readonly string[];
};

export type PatchOperation =
  | { readonly kind: "add"; readonly path: string; readonly content: string }
  | { readonly kind: "delete"; readonly path: string }
  | { readonly kind: "update"; readonly path: string; readonly moveTo?: string; readonly hunks: readonly PatchHunk[] };

type TextState = { readonly original: string | null; value: string | null };

/**
 * Codex-compatible patch primitive. The model sees one file-change tool while
 * the result preserves Add/Update/Delete/Move semantics for the UI and audit
 * stream. Every path is anchored to the current Eve workspace.
 */
export default defineTool({
  description: "Apply a Codex-style patch to files in /workspace. The patch must start with *** Begin Patch and end with *** End Patch, with no text outside that envelope. Supports Add File, Update File, Delete File, and Move to. Updates may contain multiple @@ hunks matched by exact context. Use this instead of inventing shell patch commands.",
  inputSchema: z.object({ patch: z.string().min(1).max(512 * 1024) }).strict(),
  outputSchema: z.object({
    changes: z.array(z.object({
      addedLines: z.number(),
      deletedLines: z.number(),
      kind: z.enum(["add", "update", "delete", "move"]),
      path: z.string(),
    })),
    filesChanged: z.number(),
    totalAddedLines: z.number(),
    totalDeletedLines: z.number(),
  }),
  async execute(input, ctx) {
    const abortSignal = ctx.abortSignal;
    abortSignal?.throwIfAborted();
    const operations = parsePatch(input.patch);
    abortSignal?.throwIfAborted();
    const sandbox = await ctx.getSandbox();
    const states = new Map<string, TextState>();
    const changes: FileChange[] = [];

    // Read and validate every operation before writing anything. This makes a
    // multi-file patch all-or-nothing for parse/context/path conflicts.
    for (const operation of operations) {
      abortSignal?.throwIfAborted();
      const path = workspacePath(operation.path);
      const source = await stateFor(path, sandbox, states, abortSignal);
      if (operation.kind === "add") {
        if (source.value !== null) throw new Error(`Cannot add ${path}: the file already exists.`);
        const content = operation.content;
        source.value = content;
        changes.push({ addedLines: countLines(content), deletedLines: 0, kind: "add", path });
        continue;
      }
      if (operation.kind === "delete") {
        if (source.value === null) throw new Error(`Cannot delete ${path}: the file does not exist.`);
        source.value = null;
        changes.push({ addedLines: 0, deletedLines: countLines(source.original ?? ""), kind: "delete", path });
        continue;
      }

      if (source.value === null) throw new Error(`Cannot update ${path}: the file does not exist.`);
      const result = applyUpdateText(source.value, operation.hunks);
      const destination = operation.moveTo ? workspacePath(operation.moveTo) : path;
      if (destination !== path) {
        const target = await stateFor(destination, sandbox, states, abortSignal);
        if (target.value !== null) throw new Error(`Cannot move ${path} to ${destination}: the destination already exists.`);
        target.value = result.content;
        source.value = null;
      } else {
        source.value = result.content;
      }
      changes.push({
        addedLines: result.addedLines,
        deletedLines: result.deletedLines,
        kind: destination === path ? "update" : "move",
        path: destination,
      });
    }

    // Commit only states whose final value differs from their initial value.
    // Each file is still replaced atomically, while the active turn's abort
    // signal is honoured between files and by every sandbox I/O. A multi-file
    // patch can therefore stop promptly without ever exposing a half-written
    // individual file; Eve's durable event stream records the changes that did
    // commit before the cooperative cancellation boundary.
    abortSignal?.throwIfAborted();
    for (const [path, state] of states) {
      abortSignal?.throwIfAborted();
      if (state.value === state.original) continue;
      if (state.value === null) {
        await sandbox.removePath({ abortSignal, force: true, path });
      } else {
        await writeAtomicTextFile(sandbox, path, state.value, abortSignal);
      }
    }

    return {
      changes,
      filesChanged: new Set(changes.map((change) => change.path)).size,
      totalAddedLines: changes.reduce((total, change) => total + change.addedLines, 0),
      totalDeletedLines: changes.reduce((total, change) => total + change.deletedLines, 0),
    };
  },
});

async function stateFor(
  path: string,
  sandbox: SandboxSession,
  states: Map<string, TextState>,
  abortSignal?: AbortSignal,
): Promise<TextState> {
  const known = states.get(path);
  if (known) return known;
  const original = await sandbox.readTextFile({ path, ...(abortSignal ? { abortSignal } : {}) });
  const state: TextState = { original, value: original };
  states.set(path, state);
  return state;
}

/** Parse the complete Codex patch envelope and all strict file operations. */
export function parsePatch(value: string): PatchOperation[] {
  const lines = value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
  const begin = lines.findIndex((line) => line.trim() === "*** Begin Patch");
  const end = lines.findIndex((line, index) => index > begin && line.trim() === "*** End Patch");
  if (begin < 0 || end < 0) throw new Error("Patch must contain *** Begin Patch and *** End Patch.");
  if (lines.slice(0, begin).some((line) => line.trim() !== "") || lines.slice(end + 1).some((line) => line.trim() !== "")) {
    throw new Error("Patch contains content outside its Begin/End envelope.");
  }

  const operations: PatchOperation[] = [];
  for (let index = begin + 1; index < end;) {
    if (lines[index]!.trim() === "") {
      index += 1;
      continue;
    }
    const add = /^\*\*\* Add File:\s*(.+?)\s*$/u.exec(lines[index]!);
    if (add) {
      const body: string[] = [];
      index += 1;
      while (index < end && !lines[index]!.startsWith("*** ")) {
        const line = lines[index]!;
        if (!line.startsWith("+")) throw new Error(`Add File ${add[1]} contains a non-addition line.`);
        body.push(line.slice(1));
        index += 1;
      }
      operations.push({ content: body.length === 0 ? "" : `${body.join("\n")}\n`, kind: "add", path: add[1]! });
      continue;
    }
    const remove = /^\*\*\* Delete File:\s*(.+?)\s*$/u.exec(lines[index]!);
    if (remove) {
      operations.push({ kind: "delete", path: remove[1]! });
      index += 1;
      continue;
    }
    const update = /^\*\*\* Update File:\s*(.+?)\s*$/u.exec(lines[index]!);
    if (update) {
      const path = update[1]!;
      index += 1;
      let moveTo: string | undefined;
      if (index < end) {
        const move = /^\*\*\* Move to:\s*(.+?)\s*$/u.exec(lines[index]!);
        if (move) {
          moveTo = move[1]!;
          index += 1;
        }
      }
      const body: string[] = [];
      while (index < end && !lines[index]!.startsWith("*** ")) {
        body.push(lines[index]!);
        index += 1;
      }
      const hunks = parseHunks(body, path);
      operations.push({ ...(moveTo ? { moveTo } : {}), hunks, kind: "update", path });
      continue;
    }
    throw new Error(`Unsupported patch directive: ${lines[index]}`);
  }
  if (operations.length === 0) throw new Error("The patch did not contain a file operation.");
  return operations;
}

function parseHunks(lines: readonly string[], path: string): PatchHunk[] {
  if (lines.length === 0) throw new Error(`Update File ${path} has no hunks.`);
  const hunks: PatchHunk[] = [];
  let currentHeader: Omit<PatchHunk, "lines"> = {};
  let currentLines: string[] = [];
  const flush = () => {
    if (currentLines.length === 0) throw new Error(`Update File ${path} contains an empty hunk.`);
    const oldCount = currentLines.filter((line) => line.startsWith(" ") || line.startsWith("-")).length;
    const newCount = currentLines.filter((line) => line.startsWith(" ") || line.startsWith("+")).length;
    // Models occasionally emit a unified-diff header copied from a wider
    // context window while returning only the changed lines. The actual
    // prefixed lines are authoritative: applyUpdateText locates them by exact
    // context and still rejects stale or ambiguous patches. Header counts are
    // therefore advisory rather than a second, conflicting source of truth.
    hunks.push({ ...currentHeader, lines: currentLines });
    currentLines = [];
  };
  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (currentLines.length > 0) flush();
      currentHeader = parseHunkHeader(line, path);
      continue;
    }
    if (!/^[ +\-]/u.test(line)) throw new Error(`Update File ${path} contains an invalid hunk line: ${line}`);
    currentLines.push(line);
  }
  flush();
  return hunks;
}

function parseHunkHeader(line: string, path: string): Omit<PatchHunk, "lines"> {
  // Codex commonly emits a bare `@@` when the context itself is sufficient to
  // locate the edit. Treat it as an unpositioned hunk instead of rejecting the
  // otherwise valid patch with "invalid hunk header: @@".
  if (line.trim() === "@@") return {};
  const match = /^@@(?: -(\d+)(?:,(\d+))?)?(?: \+(\d+)(?:,(\d+))?)? @@(?: .*)?$/u.exec(line);
  if (!match) throw new Error(`Update File ${path} contains an invalid hunk header: ${line}`);
  return {
    ...(match[1] !== undefined ? { oldStart: Number(match[1]), oldCount: match[2] === undefined ? 1 : Number(match[2]) } : {}),
    ...(match[3] !== undefined ? { newStart: Number(match[3]), newCount: match[4] === undefined ? 1 : Number(match[4]) } : {}),
  };
}

export type AppliedUpdate = { readonly content: string; readonly addedLines: number; readonly deletedLines: number };

/** Apply multiple hunks with exact context matching and conflict detection. */
export function applyUpdateText(current: string, hunks: readonly PatchHunk[]): AppliedUpdate {
  const normalized = current.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
  const trailingNewline = normalized.endsWith("\n");
  const body = trailingNewline ? normalized.slice(0, -1) : normalized;
  const target = body.length === 0 ? [] : body.split("\n");
  let addedLines = 0;
  let deletedLines = 0;

  for (const hunk of hunks) {
    const oldLines = hunk.lines.filter((line) => line.startsWith(" ") || line.startsWith("-")).map((line) => line.slice(1));
    const newLines = hunk.lines.filter((line) => line.startsWith(" ") || line.startsWith("+")).map((line) => line.slice(1));
    const insertionStart = hunk.oldStart ?? hunk.newStart;
    const insertionHint = insertionStart === undefined ? undefined : insertionStart === 0 ? 0 : insertionStart - 1;
    const at = locateHunk(target, oldLines, insertionHint);
    target.splice(at, oldLines.length, ...newLines);
    addedLines += hunk.lines.filter((line) => line.startsWith("+")).length;
    deletedLines += hunk.lines.filter((line) => line.startsWith("-")).length;
  }

  const outputTrailingNewline = trailingNewline || (target.length > 0 && body.length === 0);
  return {
    content: target.join("\n") + (outputTrailingNewline && target.length > 0 ? "\n" : ""),
    addedLines,
    deletedLines,
  };
}

function locateHunk(lines: readonly string[], oldLines: readonly string[], hint: number | undefined): number {
  if (oldLines.length === 0) {
    const at = hint ?? lines.length;
    if (at < 0 || at > lines.length) throw new Error(`The patch insertion point is outside the current file.`);
    return at;
  }
  const matches: number[] = [];
  for (let index = 0; index <= lines.length - oldLines.length; index += 1) {
    if (oldLines.every((line, offset) => lines[index + offset] === line)) matches.push(index);
  }
  if (matches.length === 0) throw new Error("The patch context does not match the current file.");
  if (hint !== undefined && matches.includes(hint)) return hint;
  if (matches.length > 1) throw new Error("The patch context is ambiguous; include a more specific hunk or line header.");
  return matches[0]!;
}

export function workspacePath(value: string): string {
  const path = value.startsWith("/") ? value : `/workspace/${value}`;
  const relative = path.slice("/workspace/".length);
  if (!relative || !path.startsWith("/workspace/") || path.includes("\\") || path.includes("\0") || relative.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error("Patch paths must stay inside /workspace and cannot contain traversal or empty segments.");
  }
  return path;
}

async function writeAtomicTextFile(
  sandbox: SandboxSession,
  path: string,
  content: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (typeof sandbox.run !== "function") {
    await sandbox.writeTextFile({ content, path, ...(abortSignal ? { abortSignal } : {}) });
    return;
  }
  const slash = path.lastIndexOf("/");
  const temporary = `${path.slice(0, slash + 1)}.${path.slice(slash + 1)}.open-agent-${randomUUID()}.tmp`;
  await sandbox.writeTextFile({ content, path: temporary, ...(abortSignal ? { abortSignal } : {}) });
  try {
    const result = await sandbox.run({
      command: `mv -f -- ${shellQuote(temporary)} ${shellQuote(path)}`,
      ...(abortSignal ? { abortSignal } : {}),
    });
    if (result.exitCode !== 0) throw new Error(`Atomic patch write failed for ${path}: ${result.stderr || "rename command failed"}`);
  } catch (error) {
    // Cleanup must outlive the turn cancellation signal; otherwise an abort
    // during the rename leaves the temporary file in the workspace.
    await sandbox.removePath({ force: true, path: temporary }).catch(() => undefined);
    throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

export function countLines(value: string): number {
  if (value.length === 0) return 0;
  const normalized = value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
  return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n").length : normalized.split("\n").length;
}
