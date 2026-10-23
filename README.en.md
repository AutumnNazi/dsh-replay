# 回言 · Re:Play

[简体中文](README.md)

Re:Play (回言) adds input recall and user-message replay to DSH. Both the repository and the installable package are named `dsh-replay`.

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
- **Older messages, page by page**: session entry reads user messages and may fetch one page with `loadOlder()`. At the oldest loaded entry, it fetches another only if DSH reports `hasMore`. Without more messages, it stops requesting pages.
- **On-demand loading without a default entry cap**: the native component loads older inputs page by page and no longer stops at 100 or 2,000 entries. It does not preload the entire session in the background. Memory grows with the history already loaded and its text length, and is released when the component is disabled. Available history still depends on the session records provided by DSH.

History lives in memory while the component is running, not in a separate permanent archive. Refilling old inputs depends on the session messages DSH can provide.

## Prompt replay

The action row below user messages shows the timestamp, copy, and retry actions in that order. Clicking retry appends the message’s **text** as a new prompt in the current session using `queue` mode.

- It does not replace, delete, or modify the original message or rewrite existing answers.
- Only text is resent; images and other attachments from the original message are not uploaded again.
- The retry button cannot be clicked while the current session is generating an answer.
- A failed send displays its reason rather than being treated as success.
- Disabling Message Retry removes its user-message rendering override and restores DSH host rendering. Input History can keep running.

Retry is for user prompts, including older user messages missing some source markers. Tool injection, runtime context, and messages steering an ongoing generation do not get retry actions.

## Installation and migration

You need a working DSH installation and Node.js. Installation from a local directory or a GitHub repository is supported. No npm installation command is provided, and this does not imply the package has been published to npm.

### Migrate from the old package

**Disable or uninstall `dsh-shuru` before installing `dsh-replay`. Do not enable both packages at the same time**, as shortcut and user-message rendering registrations may conflict.

Old switch values are not migrated; both native components in the new package start enabled.

### Install from a local directory

```sh
git clone https://github.com/AutumnNazi/dsh-replay.git
cd dsh-replay
node scripts/build.mjs
```

In the DSH plugin management page, choose installation from a local directory, select the cloned `dsh-replay` project directory, and follow DSH prompts to load it.

### Install from a GitHub repository

In the DSH plugin management page, choose installation from a GitHub repository and use the following repository URL. Follow DSH prompts to complete installation:

```text
https://github.com/AutumnNazi/dsh-replay.git
```

## Development and checks

Run these commands in the project directory:

```sh
node scripts/build.mjs
node scripts/check.mjs
node --test
```

`build` generates client and entry artifacts in `lib/`; `check` checks the manifest, patch, built artifacts, and extension-surface constraints; `node --test` runs automated tests. Editing `src/` alone does not update the installable bundle.

## How updates take effect

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
