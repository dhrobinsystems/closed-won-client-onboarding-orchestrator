# Contributing

Thanks for helping improve `closed-won-client-onboarding-orchestrator`. This project automates actions that reach real clients, so safety and reproducibility come first.

## Ground rules

1. **Business logic lives in `src/` only.** Never edit the generated region of a Code node (between the `BEGIN/END GENERATED BUNDLE` markers). Edit `src/` and run `npm run build`.
2. **Zero runtime dependencies.** `src/` modules may only `require('./sibling')`. Inject anything platform-specific (crypto, HTTP) from node glue code.
3. **Sandbox first.** New side-effecting HTTP nodes must sit behind a node annotated `[sandbox-gate:live-output=N]`. Only read-only or internal-preview nodes may be marked `[sandbox-safe]`. `npm run check` enforces this.
4. **No secrets.** Credential IDs stay `REPLACE_WITH_YOUR_CREDENTIAL_ID`. Sample data uses `example.com` / `example.net` / `example.org` and fictional companies only.
5. **Keep the human in the loop.** Changes must not allow external invites or client communication without the approval gate.

## Development workflow

```bash
git clone https://github.com/dhrobinsystems/closed-won-client-onboarding-orchestrator.git
cd closed-won-client-onboarding-orchestrator
npm test          # node --test (no install needed)
npm run build     # compile src/ into workflows/*.json
npm run check     # integrity, credentials, secrets, sync, sandbox gates
npm run simulate  # offline dry run on samples/
```

Before opening a pull request:

- [ ] Tests added or updated for every behaviour change (`tests/*.test.js`)
- [ ] `npm test`, `npm run build` and `npm run check` pass, with no diff in `workflows/` after the build
- [ ] Docs updated (`README.md`, `docs/`, `.env.example`) for new variables or nodes
- [ ] Screenshots in `assets/` refreshed if the canvas changed noticeably

## Adding a node glue block

Use `runCodeNode()` from `tests/helpers/n8n-harness.js` to execute the node's exact JSON source with mocked `$input`, `$('Node')`, `$env` and static data. Every new Code node should have at least one harness test.

## Commit style

Use concise, imperative messages, for example `planner: add Linear workspace provider`. Reference issues where relevant.

## Reporting security issues

Please don't open public issues for vulnerabilities. Contact the maintainer through <https://dhrobinsystems.com>.

By contributing, you agree that your contributions are licensed under the MIT License.
