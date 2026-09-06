# Working on the Rebuno TypeScript SDK

This is Rebuno's ESM-only Node.js SDK with no runtime dependencies. The Go kernel
owns durable state, policy decisions, and step identity. Read
[CONTRIBUTING.md](CONTRIBUTING.md) for setup and the contribution workflow.

## Development and validation

Use the Node and pnpm versions declared in `package.json` and CI. Install with
`pnpm install --frozen-lockfile`. For TypeScript changes, run focused tests, then
`pnpm test`, `pnpm typecheck`, and `pnpm lint`. Run `pnpm build` for changes to
public exports, declarations, or build configuration. See the package scripts
for other commands; keep the lockfile consistent with dependency changes.

Reuse fake kernels and injected fetch implementations for unit tests; clean up
timers, servers, and mocks. For documentation-only changes, check paths,
commands, and implementation consistency; runtime tests are unnecessary.
Report checks that could not run and why.

## SDK constraints

- Preserve ESM relative imports with `.js` suffixes, strict typing, useful generic
  inference, and zero runtime dependencies. Keep public exports and snake_case
  wire-to-camelCase SDK conversions aligned with API changes.
- Submit effects before invoking their bodies. The kernel assigns step IDs and
  occurrences; replay returns recorded outcomes without invoking the effect.
  Preserve the `safe_to_retry` and `at_most_once` contracts.
- Scope execution context and cancellation to each dispatch. Concurrent
  executions must not share mutable dispatch state. Preserve abort propagation
  when superseding handlers and clean up heartbeat timers on exit.
- Sign exact request bytes, verify raw webhook bodies, and preserve dispatch ID
  and attempt headers. Attempt ordering is scoped to a dispatch ID.
- Keep suspension, termination, and lease loss distinct from effect failures.
  Suspended or superseded handlers must not complete or fail the execution,
  including when user code catches a control-flow exception.
- Preserve framework-facing tool metadata and schemas. Keep streamed deltas
  best-effort and response recording durable; test replay, consumer cancellation,
  and midstream failure when changing interception.

Check the kernel protocol and Python SDK when changing shared semantics.
Update the [TypeScript SDK docs](https://github.com/rebuno/rebuno/tree/main/docs/sdk/typescript),
examples, and relevant agent-building guidance in the main Rebuno repository
with public behavior changes. These are available in `../rebuno/` when using
sibling checkouts.

## Comments, tests, and documentation style

Write for someone reading the finished system with no access to the task
conversation. Changes should read as a natural part of the codebase.

- Keep comments and docstrings sparse and concise. Explain non-obvious intent,
  invariants, or constraints; omit restatements of code and announcements of edits.
- Keep conversation references, review replies, and abandoned approaches out of
  source, tests, and docs. Put change history in PRs, commits, release notes, or
  migration guides when relevant.
- Describe current behavior directly in the present tense. Avoid change-relative
  wording such as "now", "previously", or "X instead of Y" unless it explains a
  lasting distinction or compatibility rule.
- Update existing documentation and examples in place. Avoid appended fix notes
  and repeated caveats. Review additions for wording that depends on the task
  discussion or previous patch.
- Add focused regression tests for meaningful behavior and failure modes. Name
  tests for the behavior they verify; avoid redundant coverage, assertions that
  mirror implementation details, and commentary about the debugging session.
