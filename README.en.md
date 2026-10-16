# DSH Personal

Personal is a workbench plugin for DeepSeek Harness: task timelines, screenshot-supported task documents, native Agent chat, Codex/Cursor archives, code progress, daily/weekly retrospectives, incident investigations, and reviewed personal profiles.

The official DSH chat, model settings, tools, approvals, and themes remain available. The declared patches in `patches/` preserve welcome copy and bound native JSON record reads; no chat or agent behavior is forked.

## Requirements

- Node.js 24 or later and pnpm 10.32.1.
- This release targets **official DSH 0.1.6-alpha.1**. The dependency lock installs that exact base. DSH 0.2 is not yet supported.
- Model credentials are configured in native DSH settings. TAPD, CrashSight, and Gongfeng integrations are optional and require access to their respective services.

## Install from source

```sh
git clone https://github.com/xrunmasterx/dsh-personal.git
cd dsh-personal
pnpm install --frozen-lockfile
pnpm build
node scripts/install.mjs
node scripts/start.mjs
```

The installer creates a dedicated `personal` profile under `~/.dsh-personal`. It uses the official published DSH package, preserving your other profiles and installations. The source directory remains part of this local installation; do not move or delete it without reinstalling. To select a different data home, pass the same `--home <absolute-directory>` to installation and startup. The server binds loopback only. Use `--port 3082 --no-open` for a separate test instance.

Startup uses the pinned DSH installed by this repository, in an independent profile and data home. This keeps the welcome patch and tested dependency versions consistent; an arbitrary external CLI is not a supported launch path.

## Existing Personal data

Stop the old instance before a final migration. Keep an independent backup of its entire DSH home, including attachments, sessions, settings, credentials, storages, and `personal-workbench` artifacts. Backups contain private data and must not be committed here.

```sh
node scripts/migrate.mjs --from /absolute/legacy-home --to /absolute/new-personal-home
node scripts/install.mjs --home /absolute/new-personal-home
node scripts/start.mjs --home /absolute/new-personal-home
```

Migration requires a new target and never changes the original home. It copies business data and verifies file hashes. Legacy Personal log-only metadata is explicitly classified as optional; its content, sequence, and timestamps remain intact. Unknown Personal event kinds or events that modify the native message surface abort migration. Native conversation messages are not rewritten or removed. New conversation bindings and task-editor audit are stored in `personal_plugin_records`; the official DSH request log continues to own model history.

Installation imports the legacy web profile’s Personal host configuration into an empty Personal profile automatically. Keep its data root inside the new home, preserve account namespaces, and configure your own project, model, repositories, branches, and optional `profileIdentity`. Do not reuse a path into the old home for writable data. The original home is your rollback point; changes made after migration are not automatically copied back.

## Configuration

The bundle's [`cordis.patch.yml`](packages/personal/cordis.patch.yml) supplies defaults. User overrides live under `$DSH_HOME/profiles/personal/cordis.patch.yml`; a matching row replaces the entire configuration object, so copy the full host row before editing it. Credentials belong to the DSH credential service, never this file or browser preferences. Repository author/branches and archive models have native settings pages. Background code collection starts disabled.

## Repository structure

- `packages/personal`: bundle and installation entry.
- `packages/host`: durable business state, tools, collection, and analysis.
- `packages/api`: generated Remote assembly and authenticated downloads.
- `packages/client`: Personal layout and business UI; native DSH conversation remains embedded.
- `scripts`: standalone build, profile installation, startup, and non-destructive migration.

All four packages are released together. Their package names are independent of their storage domains; existing domain names and business IDs are retained. DSH is a versioned external dependency. Build output is regenerated locally rather than copied from a modified DSH checkout.

## Update and backup

Back up the data home, stop Personal, update this repository, run `pnpm install --frozen-lockfile`, rebuild, reinstall into the same home, then restart. DSH upgrades are separate changes and must pass the compatibility tests before the pinned version is changed. Do not run an older release against data migrated by a newer incompatible release.

This repository backs up **code**. Your work records, screenshots, imported conversations, code diffs, reports, credentials, and local configuration remain private in the selected data home and require a separate backup.

## License

MIT. The retained DeepSeek license notice covers the original Personal implementation and DSH-derived interfaces. DSH and other dependencies retain their own licenses.

## Compatibility adapters

`pnpm` applies `patches/conversation-welcome-0.1.6.patch` to the pinned official Conversation artifact, changing only its Chinese and English welcome strings. The official component, event assembly, composer, and chat state remain intact. `scripts/typert-tool.mjs` adapts the build generator to recognize Remote decorators in published SDK declarations; it writes a temporary build tool, without changing the installed generator or application runtime. `patches/storage-json-0.1.6.patch` bounds concurrent native record reads and reports file-descriptor exhaustion instead of silently treating records as absent. All adapters must be reviewed when upgrading DSH.

## Verification

Run `pnpm build`, `pnpm test`, and `node scripts/check-public.mjs`. Tests exercise the business owners, UI interactions, migration frame validation, configuration migration, and the welcome patch. Optional enterprise services require your own credentials, repositories, and local tools; a successful offline test run does not assert their availability.
