# Working on the Rebuno TypeScript SDK

This repository contains Rebuno's ESM-only Node.js SDK with no runtime
dependencies. It hosts agents, routes effects through the kernel, and exposes a
client for executions and approvals. The Go kernel owns durable state, policy
decisions, and step identity. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the
contribution workflow.

## Repository map

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Public value and type exports. |
| `src/agent.ts` | Webhook handling, Node server, dispatch tasks, handler lifecycle. |
| `src/context.ts`, `src/execution.ts` | Ambient execution context, step decisions, replay, heartbeats. |
| `src/kernel.ts`, `src/crypto.ts` | Signed agent requests, dispatch leases, HMAC helpers. |
| `src/client.ts`, `src/types.ts`, `src/errors.ts` | Public client, wire-model conversion, SDK errors and refusal conversion. |
| `src/tool.ts`, `src/step.ts`, `src/mcp.ts` | Durable tools, local steps, and MCP adapters. |
| `src/fetch.ts` | LLM fetch interception, response recording, streaming, refusal responses. |
| `tests/` | Vitest coverage; fake kernels and context helpers in `tests/helpers.ts`. |

SDK documentation and examples live in the main Rebuno repository under
`docs/sdk/typescript/` and `examples/typescript/`. The Python SDK and dashboard
are separate repositories. Edit `src/`; `dist/` and `node_modules/` are generated
output and installed dependencies.

## Development and validation

Use Node 22+ and the pnpm version declared in `package.json`. The supported Node
matrix is in [.github/workflows/ci.yml](.github/workflows/ci.yml). Run commands
from this root:

| Command | Purpose |
| --- | --- |
| `pnpm install --frozen-lockfile` | Install locked dependencies, matching CI. |
| `pnpm test tests/execution.test.ts` | Example of focused tests; adjust to the affected files. |
| `pnpm test` | Run Vitest once. |
| `pnpm test:watch` | Run Vitest in watch mode while iterating. |
| `pnpm typecheck` | Check source types with `tsc --noEmit`. |
| `pnpm lint` | Run Biome checks. |
| `pnpm format` | Apply Biome formatting and fixes. |
| `pnpm build` | Bundle ESM with tsup and emit declarations with TypeScript. |

For TypeScript changes, run focused tests while iterating, then `pnpm test`,
`pnpm typecheck`, and `pnpm lint` before handing off. Run `pnpm build` when
changing public exports, declarations, or build configuration. Type checking
includes `src/`; tests run through Vitest and are excluded from `tsconfig.json`.
Scope formatting to changed files when unrelated edits are present. Keep
`pnpm-lock.yaml` consistent with dependency changes.

Tests use fake kernels and injected fetch implementations, so the existing suite
does not require a running kernel or live LLM provider. Reuse `tests/helpers.ts`
and nearby request/stream helpers; clean up timers, servers, and mocks. For
documentation-only changes, check paths, commands, and implementation
consistency; runtime tests are unnecessary. Report checks that could not run
and why.

## SDK invariants

- Submit effects before invoking their bodies. The kernel returns step IDs and
  counts occurrences; keep that responsibility in the kernel. Replay returns
  recorded results or errors without invoking the effect. Preserve the
  `safe_to_retry` and `at_most_once` idempotency contracts.
- Keep execution context scoped with `AsyncLocalStorage`. Concurrent executions
  must not share mutable dispatch state. Preserve `AbortController` propagation
  and lease checks when superseding a handler; stop heartbeat timers when the
  dispatch ends and keep the event loop responsive.
- Sign the exact request bytes sent to the kernel and verify webhook signatures
  against the raw body. Preserve dispatch ID and attempt headers on durable
  mutations and heartbeats. Attempt ordering is scoped to a dispatch ID.
- Preserve `Blocked`, `Terminated`, and `LeaseSuperseded` as control-flow signals.
  Suspended or superseded handlers must not complete or fail the execution.
  Keep policy refusals, rate limits, tool failures, and transport errors distinct
  through tool wrappers and provider-error conversion.
- Tools and local steps require an active execution. LLM fetch interception
  passes requests through when there is no execution context or eligible JSON
  body. Preserve these boundaries and the injectable fetch interface.
- Preserve tool names, schemas, callable metadata, and recorded arguments when
  changing tool or MCP wrappers; framework integrations depend on them.
- Keep streamed deltas best-effort and the recorded response durable. Cover
  stream completion, consumer cancellation, midstream failure, and UTF-8 chunk
  boundaries when changing fetch interception. Replay must reconstruct the
  recorded HTTP status, content type, and body without calling the provider.

## Public API and documentation

Preserve ESM imports with `.js` suffixes for relative source imports, explicit
type exports, and strict TypeScript checking. Keep runtime dependencies at zero;
use the existing Node and web platform APIs and callable adapter seams.

Update `src/index.ts` when the public surface changes and preserve useful generic
inference for tool arguments and results. Keep snake_case wire fields and
camelCase SDK fields mapped in `src/types.ts`. Do not expose raw wire objects
where the public API promises parsed SDK types.

Add focused regression coverage for affected behavior, including replay,
suspension, stale leases, or concurrent executions where relevant. Check the
kernel's `/v0` protocol and the Python SDK when changing shared semantics; flag
any coordinated changes they need.

Update the [TypeScript SDK documentation](https://github.com/rebuno/rebuno/tree/main/docs/sdk/typescript)
and affected examples in the main repository when public API or behavior changes.
In a sibling checkout these are under `../rebuno/docs/sdk/typescript/` and
`../rebuno/examples/typescript/`. Keep the README example and relevant guidance
under `../rebuno/skills/rebuno/references/` consistent with those changes.

## Comments, tests, and documentation style

Write repository content for someone reading the finished system with no access
to the task discussion. Changes should read as a natural part of the codebase.

- Keep comments and docstrings concise. Explain non-obvious intent, invariants,
  or constraints when the code cannot express them clearly. Omit comments that
  restate the code or announce an edit.
- Keep conversation references, review replies, task instructions, and abandoned
  approaches out of code, tests, and documentation. Put implementation history
  and change rationale in PR descriptions or commit messages.
- Describe behavior directly in the present tense. Avoid change-relative wording
  such as "now", "new", "previously", "we changed", or "X instead of Y" when it
  only makes sense in the context of the change. Explain a comparison only when
  it helps the reader understand a lasting distinction or compatibility rule.
- Update existing documentation and examples in place. Integrate the final
  behavior into the relevant section; avoid appended fix notes, repeated caveats,
  and explanations of superseded designs. Release notes and migration guides
  can describe changes over time when that is their purpose.
- Name tests for the behavior or invariant they verify. Keep assertions focused
  on meaningful outcomes and failure modes. Preserve useful regression coverage;
  avoid redundant tests, assertions that merely mirror implementation details,
  and test commentary that recounts the debugging session.
- Review the diff for wording that depends on knowing the conversation or the
  previous patch. Remove it or rewrite it as a standalone explanation of the
  current system.
