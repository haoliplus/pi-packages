---
issue_title: "Fork: bounded read-only approvals and consolidated prompts"
---

# Bounded read-only approvals

## Problem Statement

The previous permission extension repeatedly asks for ordinary read-only pipelines.
The upstream replacement has useful shell and path analysis, but can allow dynamic paths, dangerous reader options, and symlinks that escape a configured directory.
One tool call may also prompt separately for its command and paths.

## Solution

Keep the existing parser, policy engine, and Pi integration.
Raise uncertain reader invocations to ask at command level, require an external directory allow to cover the real target, and prevent session grants from overriding the final configured deny.
Present all asking gates of one tool call together while preserving each permission surface, floor, and session grant.
Install this fork locally after verification, with a backed-up and migrated policy.

## User Stories

- As the operator, I can read within my project and explicitly configured tool/configuration directories without approving every pipeline spelling.
- As the operator, I am asked about other directories, writes, arbitrary execution, and unresolved access ranges.
- As the operator, I see all permission requirements before approving a tool call once.
- As the maintainer, I can distinguish this fork from upstream and install it without publishing to npm.

## Implementation Decisions

- Baseline is upstream permission-system 40.1.2.
- Add command-level facts to the existing shell analysis and use the existing ask-floor mechanism.
- Keep configured rule ordering intact; only the session override of a final configured deny changes.
- Preserve lexical deny matching while validating external allows against canonical directory containment.
- Composite requests must carry every constituent requirement through the local dialog and forwarding protocol.
- Unknown or older forwarding implementations must fail closed for composite requests.
- Rename workspace packages to `@haoliplus/*`, mark them private, retain MIT notices, and document upstream provenance.
- This fork has GitHub Issues disabled at planning time; this checked-in plan is the ready-for-agent specification instead of filing into upstream's tracker.
- The upstream improvement roadmap remains historical context; these changes implement the fork operator's explicitly approved policy.

## Testing Decisions

Use existing BashProgram, gate, real-filesystem handler, configuration, UI, and forwarding seams.
Add failing regressions before the corresponding fixes.
Cover ordinary read-only pipelines, dangerous options and scripts without path operands, computed paths, environment prefixes, symlink escapes, valid symlink roots, and deny/session precedence.
Check complete aggregate prompts, separate grants, denial, and forwarding compatibility.
Run typechecks, lint, package tests, workspace checks affected by the namespace migration, declaration builds, and a Pi 1.0.4 loading/lifecycle smoke check.

## Out of Scope

No npm publication, release dispatch, full shell interpreter, operating-system sandbox, or automatic upstream updates.
Arbitrary interpreter programs and unresolved paths remain interactive.

## Further Notes

The operator confirmed that automatic reads are limited to project directories and explicitly listed configuration/tool directories.
The operator authorized implementation, local replacement, and the private `@haoliplus/*` namespace.
Tidy-first assessment found no necessary preparatory refactor; existing boundaries support the scoped changes.
Do not collapse distinct gate facts into the first gate's authorization.

## Verification and Outcome

The implementation passed workspace typechecking, lint, and all 9,184 tests.
Permission-system and subagents declaration builds and packed public-type consumer checks passed.
Fallow's dead-code check passed.
Independent specification review found no remaining blocking findings after regressions for indirect reads and all-path forwarded authorization were added.
The final grant assertion was mutation-checked: recording the first surface twice fails even when the number of grants is correct.

The installed Pi 1.0.4 SDK passed 13 isolated runtime checks covering literal pipelines, native reads, external roots, symlink escape, one combined prompt, uncertain commands, rejection, configured denial, reload, new session, and resume.
These checks exercise permission events and a real native read; they do not use an LLM or execute the sampled shell commands.
Offline replay of 95 historical waiting commands produced 20 allows, 75 asks, and no denies under the migrated profile.
This measures classification, not total UI interactions or future session performance.

Local deployment uses the fork checkout and preserves the previous package and policy for rollback.
The operator must reload or restart an existing Pi process to activate changed extension code.
No npm publication, remote push, release, or wiki update is part of this change.
See [the policy guide](../guides/fork-readonly-policy.md) for operational limits.
