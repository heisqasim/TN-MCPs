# CLAUDE.md: engineering instructions for TN-MCPs

You are working on the **Telos Nexus multi-MCP control plane**: separate provider MCP
servers behind a thin gateway at `https://mcp.telosnexus.cloud/<provider>/mcp`. It gives
AI clients policy-checked, audited, approval-gated access to Telos Nexus infrastructure
(Cloudflare first). Models are replaceable clients. Telos Nexus owns the tools,
permissions, audit trail, and policies.

Before changing anything, read in this order:
1. `docs/TN_MCPS_MASTER_IMPLEMENTATION_PLAN.md`: the **owner's architecture and
   security contract**. Read it completely. Never edit it without the owner.
2. This file.
3. `docs/MASTER_PLAN.md`: the execution plan that implements the contract (current
   phase, the contract→phase mapping, the deviations awaiting owner sign-off, and the
   binding contracts in §A.7).

## Current phase

**Phase 1: repository foundation.** It is done when every Phase 1 exit criterion in
`docs/MASTER_PLAN.md` is met: bootstrap commits on `main`, CI green on GitHub, and
Owner Actions §1 applied or scheduled.
Next: **Phase 2: thin gateway + first MCP skeleton** (local, loopback-only, `tn_status`
only, no provider credentials, no deployment). This is the contract's P1.
Don't start a phase until its predecessor's exit criteria are met.

## Architecture in one screen

- **Processes:** `gateway/` (127.0.0.1:8790: Host/Origin checks, routing, request IDs,
  rate limits, early Access-JWT verification, header stripping, approvals store; **no
  provider credentials**) and one MCP server per provider: `mcps/cloudflare` (8701),
  `mcps/github` (8702), `mcps/oracle` (8703), `mcps/telos-control` (8704). Each runs as
  its own Unix user with only its own credentials. Ports live in `packages/config`.
- **Shared packages:** `packages/shared` (redact, loadConfig), `mcp-common` (server
  factory `createTelosMcpServer({ name, tools })` and the policy wrapper), `auth`,
  `policy`, `audit`, `approvals`, `config`, `observability`.
- **Boundaries:** only `packages/mcp-common` imports `@modelcontextprotocol/server`
  (B1), and only `packages/mcp-common/src/policy-wrapper.ts` calls SDK registration
  functions (B2). `scripts/check-boundaries.mjs` enforces both from Phase 2.
- **Protocol:** MCP **2026-07-28**, served **dual-era** with the SDK v2
  `createMcpHandler` (default `legacy: 'stateless'`), because Claude Code's v1 runtime
  and other clients still speak 2025-11-25.
- **Auth:** one path-scoped Cloudflare Access app per provider (Managed OAuth for
  humans, service tokens for machines, separate AUD each). The gateway verifies
  `Cf-Access-Jwt-Assertion` before proxying, and the MCP server verifies it again
  against its own AUD (principal contract: ARCHITECTURE §6). No token passthrough, ever.
- **Risk:** R0 read-only · R1 reversible low-risk write · R2 production write · R3
  destructive/account-wide. Scopes use the contract's vocabulary (`cloudflare:read`,
  `cloudflare:dns:write`, …, `admin:destructive`). Production approvals come only from
  the owner in the **approvals app** (a separate Access app with MFA). R3 is
  hard-disabled in production until that app exists. Every call is audited (one
  hash-chained JSONL per process).
- **Host:** Oracle A1 VM, systemd units `tn-mcp-*`, dedicated tunnel
  `tn-mcp-tunnel.service`. The VM also runs **live production services** (JARVIS, the
  Telos jobs API, another tunnel). They are not yours.

Details: `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/MASTER_PLAN.md` §A.3 (B1–B13).

## Commands

```bash
pnpm install           # frozen by CI; dependency build scripts are blocked by default
pnpm run check         # THE gate: biome ci . && tsc -b && vitest run && secret guard
pnpm test              # vitest only (the root runs every package via Vitest projects)
pnpm run lint          # biome check .
pnpm run format        # biome format --write .
pnpm run guard         # scripts/guard-secrets.mjs only
```

Nothing is done until `pnpm run check` exits 0 and you have read its output. Don't pipe
it to `tail`/`grep` when you care about the exit code. When Phase 2 creates `gateway/`,
add it to the `projects` list in `vitest.config.ts`. Vitest rejects a missing literal
directory.

## Conventions

- TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), ESM,
  NodeNext. Relative imports end in `.js`. No `any` in exported types.
- zod v4 (`import { z } from 'zod'`) for all external input.
- Packages are `@tn-mcps/<name>`, private, built with `tsc -b` into `dist/`
  (gitignored), and tested with Vitest in `<pkg>/test/`.
- Tool names: short provider prefix + snake_case ASCII: `tn_*`, `cf_*`, `gh_*`,
  `oracle_*` (e.g. `cf_list_dns_records`). Prefer semantic Telos tools
  (`tn_route_runtime`) over generic ones. Never build a generic request or shell tool on
  the normal path (contract §14). Tools never define an `approval_id` input (the policy
  wrapper adds it) and never accept secrets as arguments.
- List tools follow the result contract: `cursor`/`limit` in, `{ items, nextCursor,
  truncated }` out, 48 KiB cap.
- Tool failures the model can act on return `isError: true` with a message that names
  the fix. Protocol errors are for host-facing failures only.
- Config goes through `loadConfig()`. Secrets come from `*_FILE` paths that pass the
  secret-file rule. Anything logged or audited goes through `redact()` first.
- New directories only when the phase that needs them starts. No empty scaffolding.
- After the bootstrap, work happens on feature branches and lands on `main` through PRs
  (contract §23). Docs change in the same PR as the behavior they describe.
- Comments: sparse and useful.

## Security boundaries (non-negotiable)

1. No secrets in the repo (public), in logs, in tool output, in commits, or in chat.
   Report *where* a secret is, never its value.
2. Never use the Cloudflare Global API Key. Scoped API tokens only.
3. `.mcp.json` holds no credentials: only `${VAR}` expansion, and prefer OAuth.
4. Never forward an inbound client token to a backend or provider. Only the Access
   assertion travels past the gateway.
5. **Never approve, or try to approve, an approval request,** and never build a path
   that lets a client or agent approve. There is no config switch to relax R3, and you
   must not add one.
6. Every process binds to its assigned loopback port only. `TN_AUTH_MODE=dev` never runs
   on the host. No new inbound ports.
7. One provider's process never gets another provider's credentials. The gateway gets
   none.
8. The A1 VM is never a self-hosted runner for this public repo. CI runs on
   GitHub-hosted runners with `permissions: contents: read`.
9. You likely run as `ubuntu` with passwordless sudo on this VM. That doesn't make
   sudo in scope: use it only for actions the owner explicitly approved.

## Forbidden without explicit, in-conversation owner approval

- Any change to production DNS, zones, nameservers, Access applications, or tunnels.
- Touching existing VM services or units: `jarvis-*`, `tn-jobs-api`, the user-level
  `cloudflared.service`, `litestream`, `alghazaly*`, `tailscaled`, the `llama-server`s.
- Reading, copying, or reusing credentials that belong to other systems on the VM.
- Creating Cloudflare/GitHub/OCI credentials, or asking the owner to paste one into chat.
- Deploying to the VM; creating users; writing to `/etc`, `/opt`, `/var/lib`.
- Installing Docker or other system packages; changing iptables or Oracle security lists.
- Enabling `cf_api_execute`.
- Pushing to `main` directly once branch protection is on (use a PR), force-pushing, or
  rewriting published history.
- Editing the owner's contract document, or modifying any other repository.

Approval for one of these covers only the action described, at the time given. It
doesn't carry over to the next action.

## Approval requirements inside the product

| Risk | Example | Gate |
| --- | --- | --- |
| R0 | `cf_list_zones`, `cf_api_search` | scope + audit |
| R1 | `cf_upsert_dns_record` on a `telosnexus.space` record | scope + audit |
| R2 | `cf_upsert_dns_record` on a production zone, `cf_deploy_pages`, `cf_update_tunnel_route` | stronger scope + production-target validation + owner approval (default on) |
| R3 | delete zone, change nameservers, delete R2 bucket/Worker/Pages/tunnel, bulk DNS, credential changes, `cf_api_execute` | `admin:destructive` + single-use owner approval bound to exact args + state, every time |

When unsure, classify higher. Bulk ops are R3. The domain classification is in
`docs/CLOUDFLARE.md` §4.2 (the owner confirms it in Q4).

## Deployment (Phase 6+)

Pull-based and owner-approved per deploy: `deploy/scripts/deploy.sh <sha>` verifies a
successful push-on-`main` CI run for that exact SHA via the public GitHub API, checks
ancestry and tree identity, runs the full gate on the VM, switches atomically, restarts
only `tn-mcp-*` units, checks health and auth through each path, and rolls back
automatically on failure. Procedure: `docs/DEPLOYMENT_A1.md` §4.

## Testing expectations

- Every behavior change comes with a test that fails without it.
- Tests must exercise the real code path. Upstream fakes assert the request they
  received (method, path, and auth-header *presence*, never the value). Don't use fakes
  that answer anything.
- Security properties get tests: redaction, no-passthrough, loopback/auth-mode config,
  cross-audience denial, R3-requires-approval, approval binding and precondition,
  boundary rules.

## Docs map

`docs/TN_MCPS_MASTER_IMPLEMENTATION_PLAN.md` (owner's contract) · `docs/MASTER_PLAN.md`
(execution plan, contracts, owner actions) · `docs/ARCHITECTURE.md` ·
`docs/SECURITY.md` · `docs/DEPLOYMENT_A1.md` · `docs/CLOUDFLARE.md` ·
`docs/CLAUDE_CODE.md`. Keep them factual. When you verify something against official
docs, update the "verified" date and source link.
