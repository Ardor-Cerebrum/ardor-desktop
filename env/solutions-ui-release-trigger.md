# solutions-ui desktop release trigger

Desktop release CI resolves and builds the immutable `Ardor-Cerebrum/solutions-ui`
commit pinned by [`desktop-ui-requirements.json`](../desktop-ui-requirements.json).

Publishing a semantic `solutions-ui` release dispatches its tag and exact commit SHA to
**Sync released solutions-ui**. That workflow verifies the published release and reconciles
the single `automation/solutions-ui-release` PR. **Verify bundled solutions-ui** then builds
the production Electron bundle from trusted Desktop code and the verified UI source. Neither
workflow merges the PR or publishes a Desktop release.

If the dispatch is missed, the sync workflow runs every six hours and can be triggered manually.
Follow the canonical
[`update-solutions-ui-pin`](../.agents/skills/update-solutions-ui-pin/SKILL.md)
workflow for recovery and bridge-contract changes. This compatibility file remains at its
historical path so existing links continue to lead agents to the maintained procedure.
