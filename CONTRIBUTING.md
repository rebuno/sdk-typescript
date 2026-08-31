# Contributing to the Rebuno TypeScript SDK

Thanks for your interest in contributing. This guide covers how to set up the project locally and submit changes.

## Prerequisites

- **Node** 22+ (CI runs 22 and 24)
- **pnpm** (the version in `packageManager`)

## Getting Started

```bash
pnpm install
pnpm build       # tsup + declaration files
pnpm test        # vitest run
pnpm test:watch  # vitest in watch mode
pnpm typecheck   # tsc --noEmit
pnpm lint        # biome check
pnpm format      # biome check --write
```

SDK documentation lives in the main repo under
[docs/sdk/typescript](https://github.com/rebuno/rebuno/tree/main/docs/sdk/typescript).
If you change public API surface or behavior, update it there.

## Submitting Changes

1. Fork the repo and create a branch from `main`.
2. Make your changes. Add tests for new functionality.
3. Run `pnpm lint:fix`, then make sure `pnpm test`, `pnpm typecheck`, and `pnpm lint` pass — CI runs those three.
4. Open a pull request with a clear description of what changed and why.

## Reporting Issues

Open an issue on GitHub. Include:

- What you expected to happen
- What actually happened
- Steps to reproduce
- Relevant logs or error messages
