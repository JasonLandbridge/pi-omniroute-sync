# AGENTS.md

Instructions for AI agents working in this repository.

## Must-Do Documentation Rule

If you change source behavior, update docs in the same change.

Use this mapping:

| Change type | Docs to update |
|---|---|
| User-visible command/setup/model behavior | `README.md` |
| Dev workflow, tests, contribution process | `CONTRIBUTING.md` |
| Package scripts/deps | `README.md` Development section and `CONTRIBUTING.md` if relevant |

Do not leave code/docs inconsistent.

## Core UX Constraint

Keep model switching normal:

```text
/model <model-id>
```

Do not introduce duplicate providers or separate manual prompt-tool model lists unless user explicitly asks.

The provider should remain:

```text
omni
```

## Prompt Tool Constraint

Chat-only models should use prompt-emulated tools automatically when:

- model id/name/provider or OmniRoute `owned_by` contains `-web`
- or raw `models.json` model entry has `tool_calling:false`

Do not rely only on Pi runtime `Model` for custom metadata. Pi strips unknown fields; use raw `models.json` when needed.

## Test Before Reporting Done

Run:

```bash
bun run typecheck
bun run test
```

If tests cannot run, report exact command and failure.

## Edit Guidance

- Prefer small targeted edits.
- Keep comments on non-obvious functions.
- Preserve `/omni setup`, `/omni sync`, `/omni dashboard` behavior unless user asks to change it.
- Keep prompt-tool format and parser docs in sync.

## Important Files

| File | Why important |
|---|---|
| `index.ts` | Extension implementation. |
| `README.md` | User-facing documentation. |
| `CONTRIBUTING.md` | Dev/test workflow. |
| `package.json` | Pi extension metadata and scripts. |
