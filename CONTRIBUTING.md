# Contributing

## Setup

```bash
bun install
```

## Development Scripts

| Command | Purpose |
|---|---|
| `bun run typecheck` | Type-check the TypeScript source and tests. |
| `bun run test` | Run the complete Vitest unit suite. |
| `bun run release` | Run semantic-release with Node; intended for the release workflow, not routine local development. Requires Node 24.10.0 or newer. |

The unit suite imports both package entry points and verifies their host-specific options and native input construction. A separate import-only smoke script is intentionally unnecessary.

## Local Testing

Load the Pi adapter directly from this checkout:

```bash
pi -e ./src/pi.ts
```

Or install the package from GitHub:

```bash
pi install git:github.com/JasonLandbridge/pi-omniroute-sync
```

Then exercise the user flow:

```text
/omni setup
/omni config
/omni sync
/model
```

When testing a linked local package after source changes, run `/reload` in Pi or OMP.

## Before Opening a PR

Run:

```bash
bun run typecheck
bun run test
git diff --check
npm pack --dry-run
```

The test suite covers:

- Pi and OMP adapter loading and host-specific configuration.
- Settings defaults, normalization, secure persistence, and environment-independent paths.
- Responses provider metadata and legacy model normalization.
- Strict usable-provider filtering and provider aliases.
- Global route detection and visibility.
- Include/exclude glob matching and precedence.
- Pricing field mapping and invalid numeric values.
- Startup synchronization staleness and TTL boundaries.
- Config-dialog navigation, staged editing, native key handling, masking, validation, save/discard behavior, and in-place synchronization.

For behavior that depends on a real OmniRoute deployment, also verify `/omni setup`, `/omni sync`, `/omni test <model>`, and model selection manually.

## Documentation Rules

Keep documentation synchronized with behavior:

- User-visible setup, commands, settings, model behavior, package scripts, and dependencies belong in `README.md`.
- Development workflow and test expectations belong in `CONTRIBUTING.md`.

Do not document separate state files or configuration paths unless the implementation actually creates them. The extension's only state/configuration file is its protected `settings.json`; the host's `models.json` remains the provider registry.

## Coding Rules

- Keep host adapters in `src/pi.ts` and `src/omp.ts`.
- Put shared behavior in the narrowest existing module under `src/`.
- Preserve the normal `/model <model-id>` experience and the single `omni` provider.
- Use the host's native Responses implementation and TUI input/key handling.
- Never write the API key to `models.json`.
- Keep synchronization transactional: failed discovery must preserve the previous registered and persisted model catalog.
- Propagate cancellation through network operations and retain bounded timeouts.
- Prefer targeted changes and tests over new abstractions or dependencies.

## Commit Style

Releases use Conventional Commits. Examples:

```text
fix: reject non-finite pricing metadata
feat: add model include globs
feat!: replace a settings property
```

Common release effects:

- `fix:` produces a patch release.
- `feat:` produces a minor release.
- `BREAKING CHANGE:` or `!` produces a major release.
