/**
 * Acceptance test for issue #418.
 *
 * Reproduces the reported bug with a real symlink (no `realpathSync` mock):
 * an `external_directory` allow configured for the path as the user types it
 * (`<link>/*`) must allow access even though the OS resolves `<link>` to a
 * different canonical directory. Exercised end-to-end through the real
 * `PermissionManager` + `PermissionResolver` for both a path-bearing tool and
 * a bash command, and for an allow keyed on the symlink-resolved form too.
 */

import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BashProgram } from "#src/access-intent/bash/program";
import { describeBashExternalDirectoryGate } from "#src/handlers/gates/bash-external-directory";
import {
  type GateDescriptor,
  isGateDescriptor,
} from "#src/handlers/gates/descriptor";
import { describeExternalDirectoryGate } from "#src/handlers/gates/external-directory";
import type { ToolCallContext } from "#src/handlers/gates/types";
import { pathFlavorForPlatform } from "#src/path/path-flavor";
import { PathNormalizer } from "#src/path/path-normalizer";
import { PermissionResolver } from "#src/policy/permission-resolver";
import { SessionRules } from "#src/session/session-rules";
import type { ScopeConfig } from "#src/types";

import { createManager } from "#test/helpers/manager-harness";

// ── real symlink fixture ─────────────────────────────────────────────────────

let realDir: string;
let linkDir: string;
let cwd: string;
const tempRoots: string[] = [];

function mkTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

beforeEach(() => {
  realDir = mkTemp("ext-real-");
  writeFileSync(join(realDir, "file.ts"), "export {};\n");
  const linkParent = mkTemp("ext-link-");
  linkDir = join(linkParent, "link");
  symlinkSync(realDir, linkDir);
  cwd = mkTemp("ext-cwd-");
});

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeResolver(config: ScopeConfig) {
  const { manager, cleanup } = createManager(config);
  manager.configureForCwd(cwd);
  const resolver = new PermissionResolver(manager, new SessionRules());
  return { resolver, cleanup };
}

function readTcc(): ToolCallContext {
  return {
    toolName: "read",
    agentName: null,
    input: { path: join(linkDir, "file.ts") },
    toolCallId: "tc-1",
    cwd,
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("external_directory symlink acceptance (#418)", () => {
  it.each(["read", "bash"])(
    "asks when %s follows a nested symlink outside an allowed directory",
    async (toolName) => {
      const outside = mkTemp("ext-outside-");
      writeFileSync(join(outside, "file.ts"), "outside\n");
      symlinkSync(outside, join(realDir, "escape"));
      const path = join(linkDir, "escape", "file.ts");
      const { resolver, cleanup } = makeResolver({
        permission: {
          external_directory_read: { "*": "ask", [`${linkDir}/*`]: "allow" },
        },
      });
      try {
        const normalizer = new PathNormalizer(
          pathFlavorForPlatform(process.platform),
          cwd,
        );
        const command = `cat ${path}`;
        const tcc: ToolCallContext = {
          ...readTcc(),
          toolName,
          input: toolName === "read" ? { path } : { command },
        };
        const result =
          toolName === "read"
            ? describeExternalDirectoryGate(
                tcc,
                { dirs: [], excludedDirs: [] },
                resolver,
                normalizer,
              )
            : describeBashExternalDirectoryGate(
                tcc,
                await BashProgram.parse(command, normalizer),
                resolver,
                normalizer,
              );
        expect(isGateDescriptor(result)).toBe(true);
        expect((result as GateDescriptor).preCheck?.state).toBe("ask");
        expect(
          (result as GateDescriptor).promptDetails.accessIntent?.floor,
        ).toBe("<external-containment>");
      } finally {
        cleanup();
      }
    },
  );

  it("preserves a lexical deny even when its canonical target is inside an allowed root", () => {
    const { resolver, cleanup } = makeResolver({
      permission: {
        external_directory_read: {
          [`${realDir}/*`]: "allow",
          [`${linkDir}/*`]: "deny",
        },
      },
    });
    try {
      const result = describeExternalDirectoryGate(
        readTcc(),
        { dirs: [], excludedDirs: [] },
        resolver,
        new PathNormalizer(pathFlavorForPlatform(process.platform), cwd),
      );
      expect((result as GateDescriptor).preCheck?.state).toBe("deny");
    } finally {
      cleanup();
    }
  });

  it("asks when symlink resolution fails instead of using lexical containment", () => {
    symlinkSync("loop", join(realDir, "loop"));
    const { resolver, cleanup } = makeResolver({
      permission: {
        external_directory_read: { [`${linkDir}/*`]: "allow" },
      },
    });
    try {
      const result = describeExternalDirectoryGate(
        { ...readTcc(), input: { path: join(linkDir, "loop", "file.ts") } },
        { dirs: [], excludedDirs: [] },
        resolver,
        new PathNormalizer(pathFlavorForPlatform(process.platform), cwd),
      );
      expect((result as GateDescriptor).preCheck?.state).toBe("ask");
    } finally {
      cleanup();
    }
  });

  it("allows a path-bearing tool when the allow is keyed on the typed (symlinked) path", () => {
    const { resolver, cleanup } = makeResolver({
      permission: {
        external_directory: { "*": "ask", [`${linkDir}/*`]: "allow" },
      },
    });
    try {
      const result = describeExternalDirectoryGate(
        readTcc(),
        { dirs: [], excludedDirs: [] },
        resolver,
        new PathNormalizer(pathFlavorForPlatform(process.platform), cwd),
      );
      expect(isGateDescriptor(result)).toBe(true);
      expect((result as GateDescriptor).preCheck?.state).toBe("allow");
    } finally {
      cleanup();
    }
  });

  it("allows a path-bearing tool when the allow is keyed on the resolved path", () => {
    // Key the allow on the fully symlink-resolved directory (on macOS the
    // tmpdir root itself is a symlink, e.g. /var -> /private/var).
    const resolved = realpathSync(realDir);
    const { resolver, cleanup } = makeResolver({
      permission: {
        external_directory: { "*": "ask", [`${resolved}/*`]: "allow" },
      },
    });
    try {
      const result = describeExternalDirectoryGate(
        readTcc(),
        { dirs: [], excludedDirs: [] },
        resolver,
        new PathNormalizer(pathFlavorForPlatform(process.platform), cwd),
      );
      expect(isGateDescriptor(result)).toBe(true);
      expect((result as GateDescriptor).preCheck?.state).toBe("allow");
    } finally {
      cleanup();
    }
  });

  it("still prompts (ask) when no external_directory allow matches", () => {
    const { resolver, cleanup } = makeResolver({
      permission: { external_directory: { "*": "ask" } },
    });
    try {
      const result = describeExternalDirectoryGate(
        readTcc(),
        { dirs: [], excludedDirs: [] },
        resolver,
        new PathNormalizer(pathFlavorForPlatform(process.platform), cwd),
      );
      expect(isGateDescriptor(result)).toBe(true);
      expect((result as GateDescriptor).preCheck?.state).toBe("ask");
    } finally {
      cleanup();
    }
  });

  it("allows a bash command referencing the typed (symlinked) path", async () => {
    const { resolver, cleanup } = makeResolver({
      permission: {
        external_directory: { "*": "ask", [`${linkDir}/*`]: "allow" },
      },
    });
    try {
      const command = `cat ${join(linkDir, "file.ts")}`;
      const tcc: ToolCallContext = {
        toolName: "bash",
        agentName: null,
        input: { command },
        toolCallId: "tc-2",
        cwd,
      };
      const normalizer = new PathNormalizer(
        pathFlavorForPlatform(process.platform),
        cwd,
      );
      const program = await BashProgram.parse(command, normalizer);
      const result = describeBashExternalDirectoryGate(
        tcc,
        program,
        resolver,
        normalizer,
      );
      // Covered by a config allow → no gate, no prompt, no session entry.
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });
});
