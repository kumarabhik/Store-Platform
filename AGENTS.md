# AGENTS.md — Rules for anyone changing this repo (AI agents and humans)

This project is being built for the **Urumi AI FDE internship, Round 1: MCP Gateway on Kubernetes**.
The owner must be able to **explain every line** in a live interview, so clarity beats cleverness.

## Rule 0 — Read the three core docs before doing the next step
Before starting **any** task, read:
1. [ROADMAP.md](ROADMAP.md): what is done (`[x]`), partial (`[~]`) and not started (`[ ]`). Pick the next item from here.
2. [DESIGN.md](DESIGN.md): how the item should be built (section numbers are referenced from the roadmap).
3. [SYSTEM.md](SYSTEM.md): invariants that must not break and gotchas that already cost time.

If the task conflicts with any of them, **stop and say so** instead of silently diverging.

## Rule 1 — Keep the docs true after every change
- Update the item's marker in **ROADMAP.md** in the same change. `[x]` only after it was **run and verified**; add the proof (command or test name).
- If you changed a design decision, update **DESIGN.md** and write one line on *why*.
- If something took more than ~15 minutes to figure out, or surprised you, add an entry to **SYSTEM.md** (Symptom → Cause → Fix → Where).
- Update `Last reviewed:` in ROADMAP.md.

## Rule 2 — Work order
- Follow phase order P0 → P9, then Bonus, then Stand-outs. **A working core beats an unfinished bonus.**
- Within a phase, make the smallest change that can be verified end-to-end, verify it, then continue.
- Don't start a new phase while the previous phase has items that block the Definition of Done.

## Rule 3 — Non-negotiables (from SYSTEM.md §1)
- All upstream MCP traffic goes through `GatewayCore.callTool()` / `listTools()`. No shortcuts.
- Every tool call writes an audit row, including failures.
- No token passthrough. No upstream credential in any response, log line or browser bundle.
- No secrets in git or in plain Helm `env:`. Use K8s Secrets and `secretKeyRef`.
- API keys are hashed (SHA-256) and passwords use scrypt. Show a new key once.
- Every new workload gets readiness + liveness probes, requests + limits, non-root securityContext.
- Every retry/poll loop uses exponential backoff with a cap and jitter.
- Local vs prod differences go **only** in `values-local.yaml` / `values-prod.yaml`.
- DB migrations are additive only.

## Rule 4 — Code style
- Match the surrounding code: TypeScript strict, Fastify, `zod` for input validation, small modules in `src/<area>/`.
- Prefer the official `@modelcontextprotocol/sdk` over hand-rolled JSON-RPC.
- Comments explain *why*, not *what*. No dead code, and no TODOs without a ROADMAP item.
- Error messages must say **which component** failed and **why** (e.g. `Upstream 'woo' timed out after 15000 ms`).

## Rule 5 — Verification
- Backend: `npm --prefix backend-node run check` (typecheck) and `npm --prefix backend-node test` must pass.
- Dashboard: `npm --prefix dashboard run build` must pass.
- Helm: `helm lint` and `helm template` with **both** local and prod values must pass for every chart you touched.
- MCP servers: verify with MCP Inspector before marking done.
- If you could not run a check, say so explicitly. Don't mark `[x]`.

## Rule 6 — Environment facts
- Dev machine: **Windows 11, PowerShell 5.1**, minikube (docker driver), `kubectl`, `helm`. See SYSTEM.md G11 for shell quirks.
- Local URLs use `127.0.0.1.nip.io` + port-forward 8088 (SYSTEM.md L5).
- Scripts run in Linux containers or on the VPS must have **LF** line endings (SYSTEM.md G10).

## Rule 7 — Git
- **Agents never commit and never push.** The owner reviews and commits every change, and pushes, themselves. Leave changes uncommitted in the working tree, and at the end of a task list the changed files and suggest a commit message.
- Read-only git commands (`status`, `diff`, `log`, `ls-remote`) are fine.
- Work happens on branch `mcp-gateway`. Never put `.env*` (except `.env.example`), DB files, or build output in a suggested commit.
- Never `git push --force`, and never rewrite history that was shared.

## Rule 8 — When unsure
Ask the owner rather than guessing on: anything that deletes data or volumes, changes to auth/roles semantics, adding a new external service, or dropping a roadmap item.

<!-- Add new rules below this line, numbered. Keep each rule short and give the reason. -->
