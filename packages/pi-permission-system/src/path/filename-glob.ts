import { opendirSync, statSync } from "node:fs";
import type { PlatformPath } from "node:path";

/**
 * Snapshot a single-star filename glob under a literal POSIX directory.
 * Null means unknown, never an empty proven read. No shell is executed.
 * Include case variants and dotfiles to cover nocaseglob/dotglob conservatively.
 */
export function expandFilenameGlob(
  token: string,
  base: string,
  path: PlatformPath,
): readonly string[] | null {
  if (path.sep !== "/" || token.startsWith("-")) return null;
  const slash = token.lastIndexOf("/");
  if (slash < 0) return null;
  const parent = token.slice(0, slash + 1);
  const leaf = token.slice(slash + 1);
  if (!/^[a-zA-Z0-9_./-]+$/.test(parent)) return null;
  if (parent.split("/").includes("..")) return null;
  if (!/^[a-zA-Z0-9_.-]*\*[a-zA-Z0-9_.-]*$/.test(leaf)) return null;
  const star = leaf.indexOf("*");
  const prefix = leaf.slice(0, star).toLowerCase();
  const suffix = leaf.slice(star + 1).toLowerCase();
  const directory = path.resolve(base, parent);
  const matches: string[] = [];
  const matchesName = (name: string) =>
    name.length >= prefix.length + suffix.length &&
    name.toLowerCase().startsWith(prefix) &&
    name.toLowerCase().endsWith(suffix);
  // Bash versions differ on . and ..; resolving .. across a symlink also
  // needs physical traversal rather than lexical normalization.
  if (prefix.startsWith(".") && (matchesName(".") || matchesName("..")))
    return null;
  try {
    const handle = opendirSync(directory);
    try {
      // Bound synchronous work; an incomplete snapshot cannot exempt a glob.
      for (let count = 0; count <= 4096; count++) {
        const entry = handle.readSync();
        if (!entry) return matches.length > 0 ? matches : null;
        if (count === 4096) return null;
        // Keep policy normalization and shell/locale filename semantics exact.
        if (!/^[a-zA-Z0-9_.-]+$/.test(entry.name)) return null;
        if (matchesName(entry.name)) {
          const target = path.join(directory, entry.name);
          // Directory operands let readers such as rg discover more paths
          // than this snapshot. Devices and unresolved links are unknown too.
          if (!statSync(target).isFile()) return null;
          matches.push(target);
        }
      }
    } finally {
      handle.closeSync();
    }
  } catch {
    return null;
  }
  return null;
}
