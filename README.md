# pi-omniroute-sync

[![npm version](https://img.shields.io/npm/v/pi-omniroute-sync.svg?style=flat-square)](https://www.npmjs.com/package/pi-omniroute-sync)
[![npm downloads](https://img.shields.io/npm/dm/pi-omniroute-sync.svg?style=flat-square)](https://www.npmjs.com/package/pi-omniroute-sync)

Use an [OmniRoute](https://github.com/diegosouzapw/OmniRoute) server as a native model provider in [Pi Coding Agent](https://pi.dev) or [Oh My Pi](https://omp.sh).

The extension discovers the models your OmniRoute instance can actually use, adds them to the normal `/model` picker under the `omni` provider, attaches OmniRoute pricing and capability metadata, and sends conversations through the host's native OpenAI Responses implementation.

```text
/model openai/gpt-5
```

No second model picker or duplicate provider is introduced.

## What You Get

- One package for both `pi` and `omp`.
- Interactive setup with `/omni setup`.
- A polished, tabbed `/omni config` overlay.
- Models in the standard `/model` picker.
- Strict filtering based on active OmniRoute provider connections.
- Optional include and exclude model globs.
- Optional global `auto` and `auto/*` routing models.
- Real cost metadata from OmniRoute's pricing API.
- Native `/v1/responses` streaming and tool calls.
- Stable session affinity and prompt-cache reuse through the host.
- Safe startup refresh based on the age of the last successful sync.
- Secure extension-owned settings; API keys are never copied to `models.json`.
- Health status, model browsing, and direct model testing commands.

## Requirements

You need:

- A running OmniRoute server.
- Either:
  - Pi Coding Agent (`@earendil-works/pi-coding-agent`), or
  - Oh My Pi (`@oh-my-pi/pi-coding-agent`).

## Installation

### Pi Coding Agent

Install from npm:

```bash
pi install pi-omniroute-sync
```

Or install directly from GitHub:

```bash
pi install git:github.com/JasonLandbridge/pi-omniroute-sync
```

### Oh My Pi

Install from npm:

```bash
omp install pi-omniroute-sync
```

Or install directly from GitHub:

```bash
omp install git:github.com/JasonLandbridge/pi-omniroute-sync
```

## Quick Start

1. Start `pi` or `omp`.
2. Run:

   ```text
   /omni setup
   ```

3. Enter the OmniRoute base URL, for example:

   ```text
   http://localhost:20128
   ```

   You may enter a URL ending in `/v1`; the extension normalizes it to the server base URL.

4. Enter the OmniRoute API key, or leave it empty if your server does not require authentication.
5. Open the normal model picker:

   ```text
   /model
   ```

6. Select an OmniRoute-backed model and chat normally.

You can rerun `/omni setup` whenever the server URL or API key changes. Pressing Enter at the API-key prompt preserves an existing key.

## Commands

| Command | What it does |
|---|---|
| `/omni` | Shows the server URL, provider name, reachability, and whether a settings file exists. |
| `/omni setup` | Prompts for the server URL and API key, verifies `/v1/models`, saves the settings, and synchronizes models. |
| `/omni sync` | Performs a strict model discovery, registers the provider, updates `models.json`, and records a successful-sync timestamp. |
| `/omni models` | Discovers and lists available models grouped by provider prefix. |
| `/omni models <search>` | Lists models whose ID or display name contains the search text. |
| `/omni test <model-id>` | Sends a small non-streaming request to `/v1/responses` and displays the result. |
| `/omni dashboard` | Displays the configured OmniRoute base URL. `/omni dash` is also accepted. |
| `/omni config` | Opens the Summary and Config overlay in TUI mode. |
| `/omni help` | Displays the built-in command summary. |

Examples:

```text
/omni models gemini
/omni test openai/gpt-5
/omni sync
```


## Settings

| Host | Settings file |
|---|---|
| Pi | `~/.pi/agent/extensions/pi-omniroute-sync/settings.json` |
| OMP | `~/.omp/agent/extensions/pi-omniroute-sync/settings.json` |

Default settings:

```json
{
  "serverUrl": "http://localhost:20128",
  "providerName": "omni",
  "onlyShowUsableModels": true,
  "showGlobalRoutingModels": true,
  "includeModels": [],
  "excludeModels": [],
  "syncOnStartup": true,
  "modelCacheTtlMinutes": 60,
  "lastSuccessfulSyncAt": 0,
  "apiKey": ""
}
```

### Settings reference

| Setting | Type | Default | Behavior |
|---|---|---:|---|
| `serverUrl` | string | `http://localhost:20128` | OmniRoute base URL. Trailing slashes and a trailing `/v1` are removed. |
| `providerName` | string | `omni` | Provider key registered in the host and stored in `models.json`. Keep this as `omni` for normal operation. |
| `onlyShowUsableModels` | boolean | `true` | Shows namespaced catalog models only when their provider has a usable OmniRoute connection. |
| `showGlobalRoutingModels` | boolean | `true` | Controls all IDs equal to `auto` or beginning with `auto/`. |
| `includeModels` | string[] | `[]` | If non-empty, advertised catalog models must match at least one pattern. |
| `excludeModels` | string[] | `[]` | Advertised catalog models matching any pattern are hidden. Excludes win over includes. |
| `syncOnStartup` | boolean | `true` | Performs at most one model synchronization during session startup when the cache is stale. |
| `modelCacheTtlMinutes` | number | `60` | Number of minutes before the last successful sync is stale. Must be non-negative; `0` means always stale. |
| `lastSuccessfulSyncAt` | number | `0` | Unix timestamp in milliseconds maintained automatically after successful syncs. `0` means no successful sync has been recorded. |
| `apiKey` | string | empty | Bearer token sent to OmniRoute. Stored only in the protected extension settings file. |


Note: OmniRoute's `/v1/models` response can include models from providers that have no configured credentials or active connection. The default `onlyShowUsableModels: true` prevents those catalog-only models from appearing.

Models explicitly marked `enabled: false` are also hidden while usable-only filtering is enabled.

Set `onlyShowUsableModels` to `false` only when you intentionally want OmniRoute's full advertised model catalog.

## Model Glob Filtering

`includeModels` and `excludeModels` provide dependency-free filtering of advertised model IDs.

Supported tokens:

- `*` matches zero or more characters.
- `?` matches exactly one character.
- Every other character is matched literally.
- Matching is case-sensitive and applies to the complete model ID.

Example:

```json
{
  "includeModels": [
    "openai/*",
    "google/gemini-?"
  ],
  "excludeModels": [
    "*/deprecated-*",
    "openai/legacy-*"
  ]
}
```

This configuration:

- Allows all `openai/` IDs.
- Allows IDs such as `google/gemini-2`.
- Does not match `google/gemini-2.5` through the single `?` token.
- Removes matching deprecated or legacy IDs even when an include pattern matched.

For advertised catalog models, filters apply in this order:

1. Global routing visibility.
2. Usable-provider verification.
3. Include patterns, when the include list is non-empty.
4. Exclude patterns.

Synthetic global routing models added by the extension are controlled by `showGlobalRoutingModels`; include and exclude globs apply to models advertised by OmniRoute.

In `/omni config`, enter patterns as a comma-separated list. The extension stores them as JSON arrays.

## Global Routing Models

When `showGlobalRoutingModels` is enabled, the extension ensures these OmniRoute routing IDs are available:

```text
auto
auto/coding
auto/fast
auto/cheap
auto/offline
auto/smart
auto/lkgp
auto/best-chaos
auto/best-chat
auto/best-coding
```

If OmniRoute already advertises one of these IDs, the extension does not add a duplicate. OmniRoute resolves the selected route server-side.

Set:

```json
{
  "showGlobalRoutingModels": false
}
```

to hide `auto`, every current `auto/*` ID, and future advertised IDs in the same namespace. Ordinary IDs such as `openai/auto` are not treated as global routes.

Synthetic global models use zero cost metadata because they can route to different underlying models.

## Pricing

Every synchronization fetches model pricing from:

```text
GET /api/pricing
```

OmniRoute prices are interpreted directly as USD per million tokens and mapped to Pi's model metadata:

| OmniRoute field | Pi cost field |
|---|---|
| `input` | `cost.input` |
| `output` | `cost.output` |
| `cached`, then `cacheRead` | `cost.cacheRead` |
| `cache_creation`, then `cacheWrite` | `cost.cacheWrite` |

Missing values default to `0`. Every model receives complete cost metadata, including `tiers: []`, so Pi can safely consume both newly synchronized and older persisted model records.

A failure to fetch or parse `/api/pricing` aborts synchronization before the existing provider is replaced.

## Environment Overrides

Runtime configuration can be overridden with environment variables:

| Variable | Overrides |
|---|---|
| `OMNIROUTE_URL` | `serverUrl` |
| `OMNIROUTE_API_KEY` | `apiKey` |
| `OMNIROUTE_PROVIDER_NAME` | `providerName` |

Example:

```bash
OMNIROUTE_URL=https://omniroute.example.com \
OMNIROUTE_API_KEY=secret \
pi
```

Environment values take precedence when the extension loads runtime configuration. They are not written back to the private settings file or `models.json`.

For normal startup synchronization and complete configuration management, run `/omni setup` once so the extension-owned settings file exists. You can then keep secrets in environment variables if preferred.

## Files and Security

### Pi

| Path | Purpose |
|---|---|
| `~/.pi/agent/extensions/pi-omniroute-sync/settings.json` | All extension configuration, the API key, and the last successful sync timestamp. |
| `~/.pi/agent/models.json` | Persisted provider metadata and synchronized models. |

### Oh My Pi

| Path | Purpose |
|---|---|
| `~/.omp/agent/extensions/pi-omniroute-sync/settings.json` | All extension configuration, the API key, and the last successful sync timestamp. |
| `~/.omp/agent/models.json` | Persisted provider metadata and synchronized models. |

`settings.json` is the extension's only state/configuration file. The API key is used at runtime when registering the provider but is deliberately omitted from `models.json`. Other providers already present in `models.json` are preserved when OmniRoute synchronizes.

Treat `settings.json` as a secret. Do not commit it or copy it into a repository.

## Agent-Callable Tools

The extension registers two tools that the active model may call:

### `omniroute_status`

Checks server reachability and reports:

- Whether OmniRoute is reachable.
- Whether the extension settings file exists.
- The server URL.
- The registered provider name.

### `omniroute_sync`

Performs the same strict discovery and provider update as `/omni sync`, then reports the synchronized model count and provider name.

Both tools honor cancellation from the host. Network requests combine host cancellation with bounded request timeouts.

## Troubleshooting

### The extension says OmniRoute is unconfigured

Run:

```text
/omni setup
```

If you configure only through environment variables, make sure `OMNIROUTE_URL` is present in the environment that launched Pi or OMP.

### Setup cannot reach `/v1/models`

Verify that:

- OmniRoute is running.
- `serverUrl` points to the server root, not an unrelated proxy path.
- The API key is valid if authentication is required.
- Pi or OMP can reach the host and port.

Then check:

```text
/omni
```

### A provider's models are missing

With `onlyShowUsableModels: true`, confirm in OmniRoute that the provider connection:

- Is active.
- Has no failed test status.
- Has an alias mapping in `/api/pricing/models` when its catalog prefix differs from its canonical provider name.

Also inspect `includeModels` and `excludeModels`. Exclude patterns always win.

Use:

```text
/omni models <provider-or-model>
```

to inspect the currently discoverable set.

### `auto/*` routes are missing

Open `/omni config` and enable **Show global routing models**, or set:

```json
{
  "showGlobalRoutingModels": true
}
```

### Changes in `/omni config` disappeared

- Escape inside a text editor cancels only that field edit.
- Escape outside editing saves the draft and synchronizes.
- Ctrl+C intentionally discards the entire draft.

### A source edit is not reflected

If the extension is installed from a linked local package, run:

```text
/reload
```

For a direct one-off Pi load during development:

```bash
pi -e /path/to/pi-omniroute-sync/src/pi.ts
```

## Development

Install dependencies:

```bash
bun install
```

Validate changes:

```bash
bun run typecheck
bun run test
```

The test suite imports both Pi and OMP package entry points and covers their host-specific adapters, secure configuration, model normalization, strict provider filtering, provider aliases, global route filtering, glob matching, pricing mapping, startup staleness, staged dialog behavior, native input handling, and save/discard semantics. This unit coverage replaces a separate import-only smoke script.

Package entry points:

| Host | Entry point |
|---|---|
| Pi | `src/pi.ts` |
| OMP | `src/omp.ts` |

Core implementation:

| File | Responsibility |
|---|---|
| `src/extension.ts` | Lifecycle hooks, commands, agent tools, setup, status, and dialog orchestration. |
| `src/provider.ts` | HTTP requests, discovery, filtering, pricing, provider registration, persistence, and startup staleness. |
| `src/config-dialog.ts` | Staged tabbed overlay and host-native inline editing. |
| `src/config.ts` | Defaults, environment overrides, paths, normalization, and secure settings persistence. |
| `src/contracts.ts` | Minimal host-neutral contracts used by both adapters. |
| `src/pi.ts` | Pi adapter and native Pi TUI injection. |
| `src/omp.ts` | OMP adapter and native OMP TUI injection. |

## License

[MIT](LICENSE)
