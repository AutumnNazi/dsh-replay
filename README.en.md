# dsh-replay

[简体中文](README.md)

`dsh-replay` adds input history and user-message replay to DSH. The plugin card title stays `dsh-replay`, the repository is `AutumnNazi/dsh-replay`, and the npm installation name is **`@bxzy/dsh-replay`**. The **Input History** and **Prompt Replay** component titles still follow the DSH language.

This README covers the native-component edition of `dsh-replay` and its latest behavior. Instructions for the custom settings page in the old `dsh-shuru` package do not apply to this edition.

## Components and language

One package contains two native Cordis components: **Input History** and **Prompt Replay**. Both are enabled by default and can be enabled or disabled independently in the DSH component management page. Neither requires the other.

There is no custom settings page. This edition uses only DSH native component switches. The client polls the host component inventory once per second; changes normally take effect within about one second, with additional network or cleanup latency possible. Disabling a component disposes its functional instance rather than merely hiding a button. It does not read, migrate, or delete old switch values stored in `localStorage`; no manual browser-data cleanup is needed.

The interface supports Chinese and English and follows the DSH language setting, with no separate language switch.

## Input history

- **Current session only**: history is isolated by session, not shared across sessions. Sent inputs and older user messages in the current session are history sources; tool or runtime-injected content is not treated as user input.
- **Step through inputs**: press **↑** in the composer for older inputs and **↓** for newer ones. Moving past the newest entry restores the draft you had before browsing, including references.
- **Keep native editing**: ↑ recalls only with an empty composer or a first-line caret. Other caret movement, IME composition, and keys already consumed by DSH stay native. Arrow keys are consumed only after successful write-back.
- **Start-of-text caret**: recalling an input places the caret at the start of its content, so you can keep pressing ↑ or edit it. Editing the draft manually exits history browsing.
- **Older messages, page by page**: session entry reads user messages and may fetch one page with `loadOlder()`. At the oldest loaded entry, it fetches another on demand only if DSH reports `hasMore`, stopping when `hasMore` is `false`. Without more messages, it stops requesting pages.
- **On-demand loading without a default entry cap**: the native component loads older inputs page by page and no longer stops at 100 or 2,000 entries. It does not preload the entire session in the background. Memory grows with the history already loaded and its text length, and is released when the component is disabled. Available history still depends on the session records provided by DSH.

History lives in memory while the component is running, not in a separate permanent archive. Refilling old inputs depends on the session messages DSH can provide.

## Prompt replay

The action row below user messages shows the timestamp, copy, and retry actions in that order. Clicking retry appends the message’s **text** as a new prompt in the current session using `queue` mode.

- It does not replace, delete, or modify the original message or rewrite existing answers.
- Only text is resent; images and other attachments from the original message are not uploaded again.
- The retry button cannot be clicked while the current session is generating an answer.
- A failed send displays its reason rather than being treated as success. DSH native submission and permission checks still apply; replay does not bypass limits or elevate permissions automatically.
- Disabling Prompt Replay removes its user-message rendering override and restores DSH host rendering. Input History can keep running.

Retry is for user prompts, including older user messages missing some source markers. Tool injection, runtime context, and messages steering an ongoing generation do not get retry actions.

## Installation and migration

You need a working DSH installation and Node.js. **Use the npm installation name `@bxzy/dsh-replay` (recommended)** so the current plugin manager can use its native update-check and user-confirmation flow. Local directories and the GitHub repository remain manual source channels.

The unscoped npm package `dsh-replay` belongs to other maintainers. **It is not this project’s package; do not use it to install this plugin.**

### Migrate from an old package or Git source

If the same plugin is already installed from `git+https://github.com/AutumnNazi/dsh-replay.git` or another Git source, the user must **manually disable and uninstall the old installation** in DSH before adding `@bxzy/dsh-replay`. Publishing an npm package does not automatically change an existing installation’s source.

Disable and uninstall the old `dsh-shuru` package as well. **Do not enable an old package and the new package at the same time**, as shortcut and user-message rendering registrations may conflict. This plugin does not change configuration on the user’s behalf or automatically migrate old switch values or data. Both native components in the new package start enabled.

### Install from npm (recommended)

In the DSH plugin page, click “Add plugin”, enter the following installation name, and follow DSH prompts to install from npm:

```text
@bxzy/dsh-replay
```

The installed plugin card still shows `dsh-replay`. Keep the npm source for future update checks in this manager. A GitHub repository address cannot replace the npm installation name to obtain native update detection through the current gateway.

### Install from a local directory (manual source channel)

```sh
git clone https://github.com/AutumnNazi/dsh-replay.git
cd dsh-replay
node scripts/build.mjs
```

In the DSH plugin management page, choose installation from a local directory, select the cloned `dsh-replay` project directory, and follow DSH prompts to load it.

### Install from a GitHub repository (manual source channel)

In the DSH plugin page, use “Add plugin” with the following repository source and follow DSH prompts to complete installation:

```text
github:AutumnNazi/dsh-replay
```

To pin v0.2.0 once the release tag is available, use `github:AutumnNazi/dsh-replay#v0.2.0`. The currently verified update gateway skips GitHub/Git sources, so it cannot detect or confirm updates for them. For later versions, manually select the source version and follow DSH prompts for installation and reload.

## Native online updates

After installing `@bxzy/dsh-replay` from npm, manually check for updates in the DSH plugin management page. The currently verified manager queries npm’s `latest` version. When it finds a version difference, review the installed and available versions, open Release notes separately if needed, and click update to explicitly confirm installation. Clicking update starts execution; do not expect an additional second confirmation. Checking alone does not install anything.

The current gateway supports update detection and execution only for direct npm sources. GitHub/Git, local directories, and archive sources do not use this flow. This conclusion applies to the currently verified manager, not every DSH version. GitHub Releases and assets do not trigger npm update checks or migrate an old Git installation to npm.

This plugin has no custom `UpdatePanel`, update API, independent background checks, or new settings page, and does not install silently on its own. DSH native management handles installation and reload. Use the actual result reported by the host; on failure, check its errors and current installation state. Automatic rollback across uninstall and reinstall is not promised.

**Recheck enabled states after updating**: the current update gateway installs with `enabled: true`, so it does not guarantee preservation of a previously disabled plugin as a whole. Recheck the Input History and Prompt Replay native components and enable or disable each as needed. Both components and the Chinese/English dictionaries remain in the package; updating needs no extra settings page.

The [v0.2.0 Release](https://github.com/AutumnNazi/dsh-replay/releases/tag/v0.2.0) page will provide `bxzy-dsh-replay-0.2.0.tgz` and `SHA256SUMS.txt` once the release is created. Compare the downloaded archive’s SHA-256 with the checksum file. Checksums detect file-integrity issues; they do not replace source or package-content verification and do not trigger installation.

## Development and checks

Run these commands in the project directory:

```sh
node scripts/build.mjs
node scripts/check.mjs
node --test test/*.test.js
```

`build` generates client and entry artifacts in `lib/`; `check` checks the manifest, patch, built artifacts, and extension-surface constraints; `node --test test/*.test.js` runs only the automated tests under `test/`, avoiding an unbounded scan of temporary directories. Editing `src/` alone does not update the installable bundle.

### Release checksum file

Release maintainers first pack with their existing package manager and verify the archive’s name is `@bxzy/dsh-replay`, its version is `0.2.0`, and its contents match the release-file allowlist. Do not include host source, temporary directories, dependency directories, or credentials. npm publishing uses the package-level `publishConfig.registry` set to `https://registry.npmjs.org/`; no global registry change is needed. The following script only reads a verified archive and generates its checksum file; it does not pack, install, or publish:

```sh
node scripts/release.mjs --archive ./bxzy-dsh-replay-0.2.0.tgz --out ./release-assets
```

The archive basename must match the current `package.json`: `bxzy-dsh-replay-<version>.tgz`. Adjust the command’s filename when the version changes. The output directory receives `SHA256SUMS.txt`; the archive stays in place. Omitting `--out` uses a local temporary release directory. The script does not inspect TAR contents and cannot replace the package-content review above; it does not create a GitHub Release or run `npm publish`. Maintainers upload the archive and checksum file to the matching Release separately. Keep release assets out of Git.

## How local build updates take effect

DSH `client-hmr` polls an already loaded client bundle every **500 ms** by default. After rebuilding, allow time for an update notification. Not every source edit requires a full restart.

For a first installation or changes to the package name, manifest, component entries, or patch, follow DSH prompts to reload configuration or restart.

If a bundle update has not taken effect, try refreshing the interface and follow the host’s reload prompts.

## Verification boundaries

Builds, checks, and automated tests validate code and artifacts; they are not installation, native component management, or UI acceptance tests in a real DSH environment.

This README does not claim that every feature has been verified in the running application.

Verify start-of-text caret placement, older-session pagination, draft restoration, and independent component toggling and restart behavior in an actual DSH window. UI and component-loading details can vary with the host version.

## Repository and feedback

Project repository: [AutumnNazi/dsh-replay](https://github.com/AutumnNazi/dsh-replay).

When reporting a problem, include the DSH version, the two components’ enabled states, reproduction steps, and relevant errors. Redact message contents, credentials, and local paths.
