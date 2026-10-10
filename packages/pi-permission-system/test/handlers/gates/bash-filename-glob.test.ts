import {
  mkdirSync,
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
import { resolveBashCommandCheck } from "#src/handlers/gates/bash-command";
import { describeBashExternalDirectoryGate } from "#src/handlers/gates/bash-external-directory";
import { describeBashPathGate } from "#src/handlers/gates/bash-path";
import { isGateDescriptor } from "#src/handlers/gates/descriptor";
import { pathFlavorForPlatform } from "#src/path/path-flavor";
import { PathNormalizer } from "#src/path/path-normalizer";
import { PermissionResolver } from "#src/policy/permission-resolver";
import type { PermissionState } from "#src/types";
import { makeTcc } from "#test/helpers/gate-fixtures";
import { createInMemoryManager } from "#test/helpers/manager-harness";

describe("bounded filename globs in read commands", () => {
  let root: string;
  let cwd: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "pi-filename-glob-")));
    cwd = join(root, "project");
    mkdirSync(join(cwd, "src/marro/skill_sources"), { recursive: true });
    mkdirSync(join(cwd, "src/marro/client_instance"), { recursive: true });
    writeFileSync(join(cwd, "src/marro/skill_sources/one.py"), "one\n");
    writeFileSync(
      join(cwd, "src/marro/client_instance/skill_lifecycle.py"),
      "two\n",
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function check(
    command: string,
    pathRead: Record<string, PermissionState> = { "*": "allow" },
    bash: Record<string, PermissionState> = {
      "*": "ask",
      "cd *": "allow",
      "wc *": "allow",
      "cat *": "allow",
      "sort *": "allow",
    },
  ) {
    const normalizer = new PathNormalizer(
      pathFlavorForPlatform(process.platform),
      cwd,
    );
    const program = await BashProgram.parse(command, normalizer);
    const resolver = new PermissionResolver(
      createInMemoryManager({
        global: {
          permission: {
            "*": "ask",
            bash,
            path_read: pathRead,
            path_write: { "*": "ask" },
            external_directory: { "*": "ask" },
          },
        },
      }),
      { getRuleset: () => [] },
    );
    const tcc = makeTcc({ cwd, input: { command } });
    const paths = describeBashPathGate(tcc, program, resolver, normalizer);
    const external = describeBashExternalDirectoryGate(
      tcc,
      program,
      resolver,
      normalizer,
    );
    return {
      bash: resolveBashCommandCheck(
        command,
        program.commands(),
        undefined,
        resolver,
      ).state,
      path: isGateDescriptor(paths) ? paths.preCheck?.state : "allow",
      external: isGateDescriptor(external) ? external.preCheck?.state : "allow",
      candidates: program.pathRuleCandidates().map(({ path }) => path.value()),
    };
  }

  it("allows the reported command with wc * and verifies both expanded operands", async () => {
    const result = await check(
      `cd ${cwd} && wc -l src/marro/skill_sources/*.py src/marro/client_instance/skill_lifecycle*.py`,
    );
    expect([result.bash, result.path, result.external]).toEqual([
      "allow",
      "allow",
      "allow",
    ]);
    expect(result.candidates).toContain(
      join(cwd, "src/marro/skill_sources/one.py"),
    );
    expect(result.candidates).toContain(
      join(cwd, "src/marro/client_instance/skill_lifecycle.py"),
    );
  });

  it("honors a deny on a filename hidden by the glob", async () => {
    const result = await check("wc -l src/marro/skill_sources/*.py", {
      "*": "allow",
      "src/marro/skill_sources/one.py": "deny",
    });
    expect(result.path).toBe("deny");
  });

  it("asks for a matching symlink that escapes the project", async () => {
    const outside = join(root, "outside.py");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, join(cwd, "src/marro/skill_sources/link.py"));
    expect((await check("wc -l src/marro/skill_sources/*.py")).external).toBe(
      "ask",
    );
  });

  it("checks symlinked parent directories", async () => {
    mkdirSync(join(root, "outside"));
    writeFileSync(join(root, "outside/file.py"), "outside\n");
    symlinkSync(join(root, "outside"), join(cwd, "linked"));
    expect((await check("wc -l linked/*.py")).external).toBe("ask");
  });

  it.each([
    'wc -l "$FILES"',
    'wc -l "$(printf src/marro/skill_sources/one.py)"',
    "wc -l src/*/*.py",
    "wc -l *.py",
    "wc -l src/marro/skill_sources/{one,two}.py",
    "wc -l src/marro/skill_sources/[o]ne.py",
    'cd "$DIR" && wc -l src/marro/skill_sources/*.py',
    "wc -l missing/*.py",
    "wc -l src/marro/skill_sources/*.missing",
    "sort --output=out.txt src/marro/skill_sources/*.py",
    "PATH=/outside wc -l src/marro/skill_sources/*.py",
    "wc --files0-from src/marro/skill_sources/*.py",
    "wc --files0-f=src/marro/skill_sources/one.py",
    "wc -l src/marro/skill_sources/../skill_sources/*.py",
    "cat src/marro/skill_sources/*.py",
  ])(
    "retains approval for unsupported or unsafe invocation: %s",
    async (command) => {
      expect((await check(command)).bash).toBe("ask");
    },
  );

  it("keeps quoted globs literal", async () => {
    const result = await check("wc -l 'src/marro/skill_sources/*.py'");
    expect(result.candidates).not.toContain(
      join(cwd, "src/marro/skill_sources/one.py"),
    );
  });

  it("does not trust a partially scanned directory", async () => {
    for (let i = 0; i < 4097; i++) {
      writeFileSync(join(cwd, `src/marro/skill_sources/file-${i}.py`), "");
    }
    expect((await check("wc -l src/marro/skill_sources/*.py")).bash).toBe(
      "ask",
    );
  });

  it("retains approval for filenames outside the supported spelling", async () => {
    writeFileSync(join(cwd, "src/marro/skill_sources/space name.py"), "");
    expect((await check("wc -l src/marro/skill_sources/*.py")).bash).toBe(
      "ask",
    );
  });

  it("allows a bounded glob after an option terminator", async () => {
    const result = await check("wc -l -- src/marro/skill_sources/*.py");
    expect([result.bash, result.path, result.external]).toEqual([
      "allow",
      "allow",
      "allow",
    ]);
  });

  it("checks dot-directory matches that older Bash versions include", async () => {
    writeFileSync(join(cwd, ".hidden"), "");
    const result = await check("wc -l ./.hidden* ./.?");
    expect(result.bash).toBe("ask");
    expect((await check("wc -l ./.*")).bash).toBe("ask");
  });

  it("does not lose hidden or case-varied matches under shell glob options", async () => {
    writeFileSync(join(cwd, "src/marro/skill_sources/.hidden.PY"), "hidden\n");
    const result = await check("wc -l src/marro/skill_sources/*.py", {
      "*": "allow",
      "src/marro/skill_sources/.hidden.PY": "deny",
    });
    expect(result.path).toBe("deny");
  });

  it.each([
    "if true; then cd nested; wc -l src/*.py; fi",
    "echo $(cd nested; wc -l src/*.py)",
    "for i in 1; do cd nested; wc -l src/*.py; done",
    "if true; then cd nested; fi; wc -l src/*.py",
    "cd nested || wc -l src/*.py",
    "cd nested; wc -l src/*.py",
    "cd -P nested && wc -l src/*.py",
    "cd nested ignored && wc -l src/*.py",
    "eval 'cd nested' && wc -l src/*.py",
    "ln -s ../secret.py src/new.py && wc -l src/*.py",
    "cd nested | wc -l src/*.py",
    "echo x > src/new.py && wc -l src/*.py",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional shell parameter expansion
    'echo "${a[PATH=0]}" && wc -l src/*.py',
    'echo "$UNKNOWN" && wc -l src/*.py',
    "cd ./nested/.. && wc -l src/*.py",
    "cd nested && wc -l src/*.py",
  ])(
    "does not exempt a glob when prior execution makes the snapshot uncertain: %s",
    async (command) => {
      mkdirSync(join(cwd, "nested/src"), { recursive: true });
      mkdirSync(join(cwd, "-P/src"), { recursive: true });
      writeFileSync(join(cwd, "src/one.py"), "one\n");
      writeFileSync(join(cwd, "nested/src/one.py"), "nested\n");
      writeFileSync(join(cwd, "-P/src/one.py"), "option\n");
      expect(
        (await check(command, { "*": "allow" }, { "*": "allow" })).bash,
      ).toBe("ask");
    },
  );

  it("does not exempt directory globs for recursively reading commands", async () => {
    mkdirSync(join(cwd, "src/nested"));
    writeFileSync(join(cwd, "src/nested/secret.txt"), "secret\n");
    const result = await check(
      "rg needle src/*",
      { "*": "allow", "src/nested/secret.txt": "deny" },
      { "*": "allow" },
    );
    expect(result.bash).toBe("ask");
  });

  it("does not exempt a glob matching a symlink to a directory", async () => {
    mkdirSync(join(root, "outside"));
    symlinkSync(
      join(root, "outside"),
      join(cwd, "src/marro/skill_sources/directory.py"),
    );
    expect((await check("wc -l src/marro/skill_sources/*.py")).bash).toBe(
      "ask",
    );
  });
});
