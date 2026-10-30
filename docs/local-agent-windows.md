# Local execution on Windows

Ardor Desktop uses the existing Cerebrum/Codex Microsoft Execution Containers
(MXC) backend for protected local execution on compatible Windows devices.
An unavailable backend disables local execution with an actionable error; it
does not silently select a legacy backend, expanded access, or cloud execution.
Saved local history remains available for reading.

## Files shared through hard links

A Windows hard link is another name for the same underlying file. A file already
linked into the selected project can therefore share changes with a name outside
the project. The selected-folder boundary does not guarantee that every other
name of a writable file is also inside that folder.

This behavior was accepted for ARD-2319 on 2026-10-18 after reproducing it with
the executable shipped in Codex 26.1013.4894.0 (CLI 0.163.0-alpha.10.2), both
through its native sandbox CLI and directly through app-server. Standard
`:workspace` and Ardor's `ardor-local-workspace` profiles behaved alike: direct
outside writes were denied, while writes through pre-existing project hard links
changed the same outside file. Cerebrum reproduced the same results.

This is an acknowledged limitation of the tested behavior, not a claim of full
filesystem isolation. Reading outside the project may also be possible.
Symlink/junction traversal, direct outside writes, and undeclared permission
escalation retain their existing checks. This decision does not authorize a
fallback backend or expanded access without the user's explicit choice.

The Windows enforcement harness records an observed pre-existing hardlink write
as `KNOWN_LIMITATION`, including the actual child result and trusted observation
of the shared file. It does not report the old unchanged-file assertion as
passing. Other enforcement failures remain failures.

## Candidate builds

The manual `desktop-local-cerebrum-stage.yml` workflow accepts immutable UI and
Cerebrum source SHA overrides. Runtime source overrides are recorded in a
workspace requirements snapshot and accepted only for `stage1`; release
requirements retain their committed pin and protocol contract. The artifacts
include the candidate requirements snapshots and the sealed runtime manifest.

Windows Server CI runners without MXC verify the explicit unavailable-backend
path separately from actual protected command execution. Successful packaging or
an unavailable-host check does not certify MXC enforcement. A compatible Windows
host must run the supported execution smoke against the packaged runtime.

The local-agent regression suite uses Bun 1.4.2 in CI and candidate builds. Older
Bun HTTP server shims can omit the response-close event after a streaming client
disconnect; keep the upstream-abort assertion intact when changing the test
runtime. Electron's production relay runs under Node. Temporary-directory
fixtures must use their native canonical paths, including macOS `/private/var`
and Windows long paths, to match the verifier's actual resource paths.
