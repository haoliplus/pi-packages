# Read-only policy in this fork

Start from [the read-only example](../../config/readonly.example.json), then add explicit directory entries to `permission.external_directory_read`.
Save it as `~/.pi/agent/extensions/pi-permission-system/config.jsonc` for the global policy, or `.pi/extensions/pi-permission-system/config.jsonc` for the current project.
JSONC accepts line and block comments, without trailing commas.
An existing sibling `config.json` is used only when `config.jsonc` is absent; the two files are never merged.
Archive old `pi-permissions.jsonc` files after migration, because those legacy locations are still loaded and reported separately.
Keep `external_directory: { "*": "ask" }`; the current project is already within the boundary.
A directory normally needs both its own path and a trailing `/*` entry if the agent lists the directory as well as its contents.
Use absolute paths or `~/` paths, not a wildcard naming an entire home directory.

The read-only Bash rules are checked per command in a pipeline.
Recognized readers with dangerous options, hidden program effects, unresolved argument expansion, or an environment-assignment prefix are raised to ask even if a broad command rule allowed them.
Ordinary literal `cat`, `rg`, `find`, `sed -n`, `awk`, `head`, and `sort` combinations can therefore share a small rule set.
Interpreters, unknown commands, and writes remain interactive; `/dev/null` is the example's explicit output exception.
Directory-comparing `diff`, recursive or link-following reader flags, and indirect filename lists such as `wc --files0-from` remain conservative asks.

Filename globs such as `wc -l src/*.py` and `wc -l src/skill_lifecycle*.py` can use an existing `wc *` allow rule.
This exemption is specific to `wc`; other readers retain their existing glob approval requirement until their argument semantics are audited separately.
The checker snapshots the matching entries and sends every path through the usual path and external-directory rules, including canonical symlink targets and explicit denies.
Every match must be a regular file or a symlink to a regular file; directory matches remain interactive because readers can traverse additional files inside them.
This applies to unquoted POSIX paths with a fixed directory and one `*` in the filename; use `./*.py` for the current directory.
The supported spelling uses ASCII letters, digits, underscores, dots, hyphens, and directory separators.
Directory wildcards, parent `..` segments, other expansion syntax, unknown working directories, unreadable or empty matches, unsupported entry names, and directories containing more than 4096 entries still ask.
Dotfiles and case variants are included conservatively so shell glob settings cannot hide a protected path; explicit dot globs that could match `.` or `..` still ask.
Quoted globs remain literal filenames, and variable or command substitutions retain their approval requirement.
The exemption requires a simple reader, a successful `&&` chain of readers and literal `cd` commands, or a reader-only pipeline.
Each `cd` must have exactly one literal target beginning with `/` or `./`, without `..` segments; this avoids option parsing and inherited `CDPATH` lookup.
Control flow, substitutions, assignments, redirects, and preceding unknown or write-capable commands keep the glob interactive because the pre-execution snapshot may not describe what runs.
This snapshot has the same check-to-execution filesystem race limitation as literal path checks.

An external directory allow must also contain the canonical target under the canonical rule root.
The rule root itself may be a symlink; a nested symlink escaping that root asks again.
Lexical and canonical deny matching is retained.
The final configured deny also takes precedence over an earlier session approval, without changing last-match-wins exceptions inside the configuration.

All asking gates of a tool call are displayed together and answered once.
Session approvals retain the individual surfaces and patterns shown in that request.
Forwarded compound requests carry every requirement; an older parent that cannot acknowledge the complete request cannot approve it.
External automatic authorizers defer compound approvals to the terminal authorizer; the serving side checks each unresolved path independently so a deny on any path blocks the whole call.

This is deterministic permission checking, not an operating-system sandbox.
It assumes the installed commands and inherited environment are trusted, does not interpret arbitrary programs, and cannot eliminate filesystem races between checking and execution.
Pi's native `ls` may query metadata for symlink targets while listing a directory; this policy does not replace Pi's tool implementations or isolate those metadata probes.
Keep unresolved commands interactive and avoid universal Bash or external-directory allows when using this profile.

The fork is private and installed from a local checkout.
After changing the installed source or configuration, reload or restart Pi; keep the previous package source and configuration backup until the replacement has been verified.
