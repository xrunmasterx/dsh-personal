# Personal maintenance

Personal is an external DSH plugin. Do not vendor or change DSH behavior to make a test pass. The declared welcome-copy and bounded JSON-read patches are the only runtime-package patches in this release.

- Keep the official conversation, tools, approvals, model settings, and theme capabilities available.
- All four packages share a release version and a tested DSH version in `compatibility.json`.
- Build and test against published DSH packages. Source-relative imports must stay within Personal.
- Preserve existing storage domains, record IDs, session IDs, attachment identities, and original user content.
- New plugin metadata belongs in plugin-owned storage. Do not add unknown required events to native Session logs.
- Migration copies into a new home, verifies content, and retains the original home for rollback.
- Never commit credentials, personal configuration, real task/chat data, screenshots, imported diffs, or private backups.
- Run the standalone build and relevant Host/Client tests. Installation and restart must also work with a fresh version-pinned DSH installation and the declared compatibility patches.
- Treat DSH upgrades separately from business changes. Document compatibility limits honestly.
