# CLAUDE.md: engineering instructions for TN-MCPs

You are working on the **Telos Nexus MCP control plane**, the monorepo behind
`https://mcp.telosnexus.cloud/mcp`. It gives AI clients policy-checked, audited,
approval-gated access to Telos Nexus infrastructure (Cloudflare first). Read this file
fully before changing anything, then read `docs/MASTER_PLAN.md` for the current phase
and the binding contracts in its §A.7.

## Current phase

**Phase 1: repository foundation.** It is done when every Phase 1 exit criterion in
`docs/MASTER_PLAN.md` is met: bootstrap commits on `main`, CI green on GitHub, and
Owner Actions §1 applied or scheduled.
Next: **Phase 2: gateway core** (local, loopback-only, no providers, no deployment).
Don't start a phase until its predecessor's exit criteria are met.

## Architecture in one screen

- One MCP server: `servers/gateway` (Phase 2). It is the **only** package that imports
  `@modelcontextprotocol/server`. Only its `src/policy-wrapper.ts` may call SDK
  registration functions. Providers (`providers/*`) export `ToolDefinition`s via
  `defineTool()` (`packages/core`).
- MCP spec **2026-07-28**, served **dual-era** with the SDK v2 `createMcpHandler`
  (default `legacy: 'stateless'`), because Claude Code's v1 runtime and other clients
  still speak 2025-11-25.
- Auth: Cloudflare Access (Managed OAuth for humans, service tokens for machines) at the
  edge. The gateway verifies `Cf-Access-Jwt-Assertion` against the principal contract
  (ARCHITECTURE §4). No token passthrough to providers, ever.
- Every tool has a risk class (`read` | `write` | `destructive`), scopes, an approval
  mode, and optionally `resources()` and `precondition()`. Production approvals come
  only from the owner in the **approvals app** (a separate Access app with MFA). Every
  call is audited (hash-chained JSONL).
- Host: Oracle A1 VM, systemd, loopback `127.0.0.1:8787`, dedicated Cloudflare Tunnel.
  The VM also runs **live production services** (Jarvis, the Telos jobs API, another
  tunnel). They are not yours.

Details: `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/MASTER_PLAN.md` §A.3 (boundaries B1–B13).

## Commands

```bash
pnpm install           # frozen by CI; dependency build scripts are blocked by default
pnpm run check         # THE gate: biome ci . && tsc -b && vitest run && secret guard
pnpm test              # vitest only (the root runs every package via Vitest projects)
pnpm run lint          # biome check .
pnpm run format        # biome format --write .
pnpm run guard         # scripts/guard-secrets.mjs only
```

Nothing is done until `pnpm run check` exits 0 and you have read its output. Don't
pipe it to `tail`/`grep` when you care about the exit code.

## Conventions

- TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), ESM,
  NodeNext. Relative imports end in `.js`. No `any` in exported types.
- zod v4 (`import { z } from 'zod'`) for all external input.
- Packages are `@tn-mcps/<name>`, private, built with `tsc -b` into `dist/`
  (gitignored), and tested with Vitest in `<pkg>/test/`.
- Tool names: `<provider>_<verb>_<object>`, snake_case ASCII. Tools never define an
  `approval_id` input (the policy wrapper adds it) and never accept secrets as arguments.
- List tools follow the result contract: `cursor`/`limit` in, `{ items, nextCursor,
  truncated }` out, 48 KiB cap.
- Tool failures the model can act on return `isError: true` with a message that names
  the fix. Protocol errors are for host-facing failures only.
- Config goes through `loadConfig()`; secrets come from `*_FILE` paths that pass the
  secret-file rule. Anything logged or audited goes through `redact()` first.
- New directories only when the phase that needs them starts. No empty scaffolding.
- Comments: sparse and useful.

## Security boundaries (non-negotiable)

1. No secrets in the repo (public), in logs, in tool output, in commits, or in chat.
   Report *where* a secret is, never its value.
2. Never use the Cloudflare Global API Key. Scoped API tokens only.
3. `.mcp.json` holds no credentials: only `${VAR}` expansion, and prefer OAuth.
4. Never forward an inbound client token to a provider.
5. **Never approve, or try to approve, an approval request,** and never build a path
   that lets a client or agent approve. There is no config switch to disable approvals,
   and you must not add one.
6. The gateway binds to loopback only. `TN_AUTH_MODE=dev` never runs on the host.
   No new inbound ports.
7. The A1 VM is never a self-hosted runner for this public repo. CI runs on
   GitHub-hosted runners with `permissions: contents: read`.
8. You likely run as `ubuntu` with passwordless sudo on this VM. That doesn't make
   sudo in scope: use it only for actions the owner explicitly approved.

## Forbidden without explicit, in-conversation owner approval

- Any change to production DNS, zones, nameservers, Access applications, or tunnels.
- Touching existing VM services or units: `jarvis-*`, `tn-jobs-api`, the user-level
  `cloudflared.service`, `litestream`, `alghazaly*`, `tailscaled`, the `llama-server`s.
- Reading, copying, or reusing credentials that belong to other systems on the VM.
- Creating Cloudflare/GitHub/OCI credentials, or asking the owner to paste one into chat.
- Deploying to the VM; creating users; writing to `/etc`, `/opt`, `/var/lib`.
- Installing Docker or other system packages; changing iptables or Oracle security lists.
- Pushing to `main` directly once branch protection is on (use a PR), force-pushing, or
  rewriting published history.
- Modifying any other repository.

Approval for one of these covers only the action described, at the time given. It
doesn't carry over to the next action.

## Approval requirements inside the product

| Risk | Example | Gate |
| --- | --- | --- |
| read | `cloudflare_list_zones` | scope + audit |
| write | `cloudflare_dns_upsert` | scope + audit + approval per policy (always for production resources) |
| destructive | delete zone, change nameservers, delete R2 bucket/Worker/tunnel, bulk DNS delete | scope + audit + single-use owner approval bound to exact args + state, always |

When unsure, classify as `destructive`. Bulk ops are destructive.

## Deployment (Phase 6+)

Pull-based and owner-approved per deploy: `deploy/scripts/deploy.sh <sha>` verifies a
successful push-on-`main` CI run for that exact SHA via the public GitHub API, checks
ancestry and tree identity, runs the full gate on the VM, switches atomically, checks
health, and rolls back automatically on failure. Procedure: `docs/DEPLOYMENT_A1.md` §4.

## Testing expectations

- Every behavior change comes with a test that fails without it.
- Tests must exercise the real code path. Upstream fakes assert the request they
  received (method, path, and auth-header *presence*, never the value). Don't use
  fakes that answer anything.
- Security properties get tests: redaction, no-passthrough, loopback/auth-mode config,
  destructive-requires-approval, approval binding and precondition, boundary rules.

## Docs map

`docs/MASTER_PLAN.md` (authoritative plan, contracts, owner actions) ·
`docs/ARCHITECTURE.md` · `docs/SECURITY.md` · `docs/DEPLOYMENT_A1.md` ·
`docs/CLOUDFLARE.md` · `docs/CLAUDE_CODE.md`. Keep them factual. When you verify
something against official docs, update the "verified" date and source link.
