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
Directory-comparing `diff`, recursive or link-following reader flags, and argument globs are conservative asks because their concrete targets are not enumerated by the command line.

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
