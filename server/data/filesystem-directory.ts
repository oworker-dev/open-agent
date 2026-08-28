import { opendir } from "node:fs/promises";

/**
 * Iterate a directory without materializing every entry at once. The caller
 * can stop early (for example after a cleanup batch is full) and the handle is
 * closed even when iteration is interrupted.
 */
export async function* iterateDirectoryEntries(root: string) {
  let directory;
  try {
    directory = await opendir(root);
  } catch {
    return;
  }
  try {
    try {
      for await (const entry of directory) yield entry;
    } catch {
      // Treat a directory that disappears during iteration like a missing root.
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
}
