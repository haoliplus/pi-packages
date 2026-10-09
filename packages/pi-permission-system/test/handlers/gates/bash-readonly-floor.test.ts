import { beforeAll, describe, expect, it } from "vitest";

import { warmBashParser } from "#src/access-intent/bash/parser";
import { BashProgram } from "#src/access-intent/bash/program";
import { resolveBashCommandCheck } from "#src/handlers/gates/bash-command";
import { pathFlavorForPlatform } from "#src/path/path-flavor";
import { PathNormalizer } from "#src/path/path-normalizer";
import { PermissionResolver } from "#src/policy/permission-resolver";
import type { Ruleset } from "#src/policy/rule";
import type { PermissionState } from "#src/types";

import {
  createInMemoryManager,
  sessionRule,
} from "#test/helpers/manager-harness";

const normalizer = new PathNormalizer(
  pathFlavorForPlatform(process.platform),
  process.cwd(),
);

async function decide(
  command: string,
  bash: Record<string, PermissionState> = { "*": "allow" },
  sessionGrants: Ruleset = [],
) {
  const program = await BashProgram.parse(command, normalizer);
  const resolver = new PermissionResolver(
    createInMemoryManager({ global: { permission: { bash } } }),
    { getRuleset: () => sessionGrants },
  );
  return resolveBashCommandCheck(
    command,
    program.commands(),
    undefined,
    resolver,
  );
}

describe("read-only command floors", () => {
  beforeAll(warmBashParser);

  it.each([
    "printf x | sed 'w out.txt'",
    "awk 'BEGIN {system(\"touch out.txt\")}'",
    "awk 'BEGIN {getline x < \"/outside/file\"; print x}'",
    "rg --pre 'touch out.txt' needle",
    "awk 'BEGIN {ARGV[1]=\"/outside/file\"; ARGC=2} {print}'",
    "sort --output=out.txt",
    "find . -fprint out.txt",
    'cat "$OUTSIDE_FILE"',
    "cat \"$(printf '\\057etc\\057passwd')\"",
    "RIPGREP_CONFIG_PATH=./rg.conf rg needle README.md",
    "PATH=/outside cat README.md",
    "RIPGREP_CONFIG_PATH=./rg.conf time rg needle README.md",
    "cat *",
    "cat ./configs/*",
    "cat {one,two}.txt",
    "rg -L needle .",
    "rg --follow needle .",
    "grep -R needle .",
    "grep -r needle .",
    "grep --directories=recurse needle .",
    "find -L . -type f",
    "find . -follow -type f",
    "fd --follow needle .",
    "diff -r . packages",
    "diff --recursive . packages",
    "diff . packages",
    "diff first.txt second.txt",
    "ls -R -L .",
    "ls --dereference-command-line .",
    "ls --dereference-command-line-symlink-to-dir .",
    "stat -L file",
    "stat --dereference file",
    "sort -T /outside files.txt",
    "sort --compress-program=evil files.txt",
    "sort --files0-from=README.md",
    "sort --files0-f=README.md",
    "find -files0-from README.md -type f",
    'cat < "$OUTSIDE_FILE"',
    'echo x > "$OUTSIDE_FILE"',
    "cat < \"$(printf '\\057etc\\057passwd')\"",
  ])(
    "asks for an unproven reader even without a path token: %s",
    async (command) => {
      expect(await decide(command)).toMatchObject({
        state: "ask",
        floor: "<unproven-readonly-bash-command>",
      });
    },
  );

  it.each([
    "cat README.md | sed -n '1,60p' | head",
    "rg --files | sort",
    "find . -type f",
    "awk '{print $1}' README.md",
    "cat '$OUTSIDE_FILE'",
    'cat "$HOME/README.md"',
    'cat "$PWD/README.md"',
  ])("keeps a statically proven reader allowed: %s", async (command) => {
    expect((await decide(command)).state).toBe("allow");
  });

  it("keeps an explicit deny", async () => {
    expect(
      (await decide("sed 'w out.txt'", { "*": "allow", "sed *": "deny" }))
        .state,
    ).toBe("deny");
  });

  it.each([
    'time cat "$OUTSIDE_FILE"',
    "time sed 'w out.txt'",
    "sudo rg --pre='touch out.txt' needle",
    "env RIPGREP_CONFIG_PATH=./rg.conf rg needle README.md",
  ])(
    "keeps wrappers from restoring an unproven read claim: %s",
    async (command) => {
      expect((await decide(command)).state).toBe("ask");
    },
  );

  it("allows an approved unit without approving an unsafe sibling", async () => {
    const grants = [sessionRule("bash", "sed 'w out.txt'")];
    expect(
      (await decide("sed 'w out.txt'", { "*": "allow" }, grants)).state,
    ).toBe("allow");
    expect(
      await decide(
        "sed 'w out.txt' | awk 'BEGIN {system(\"touch other\")}'",
        { "*": "allow" },
        grants,
      ),
    ).toMatchObject({
      state: "ask",
      command: "awk 'BEGIN {system(\"touch other\")}'",
    });
  });

  it("includes environment assignments in the approval scope", async () => {
    const command = "RIPGREP_CONFIG_PATH=./rg.conf rg needle README.md";
    expect(
      await decide(command, { "*": "allow" }, [
        sessionRule("bash", "rg needle README.md"),
      ]),
    ).toMatchObject({ state: "ask", command });
    expect(
      (await decide(command, { "*": "allow" }, [sessionRule("bash", command)]))
        .state,
    ).toBe("allow");
  });
});
