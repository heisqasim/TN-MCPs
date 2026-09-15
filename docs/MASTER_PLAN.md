# TN-MCPs Master Plan

The authoritative implementation plan for the Telos Nexus MCP control plane. An
engineer (human or agent) with no other context should be able to implement the whole
project from this document plus the others in `docs/`. When reality and this plan
diverge, update the plan in the same change.

- Owner: Qasim (heisqasim)
- Host: Oracle Cloud A1 VM (see [DEPLOYMENT_A1.md](DEPLOYMENT_A1.md))
- Target endpoint: `https://mcp.telosnexus.cloud/mcp`
- Plan written: 2026-09-15 · Revision 2 (after two independent design critiques; see
  Part D) · Current phase: **1: Repository foundation**

---

## Part A: Frame

### A.1 What this is, and what it is not

TN-MCPs is **one authenticated MCP gateway** that gives AI clients policy-checked,
audited, approval-gated access to Telos Nexus infrastructure providers, plus the
shared packages (auth, policy, audit, approvals) and deployment tooling behind it.

It is **not**:
- a re-implementation of Cloudflare's (or anyone's) API. It wraps official SDKs and
  official MCP servers;
- a set of independent per-provider MCP servers. There is one gateway, and providers
  are libraries (ARCHITECTURE §9);
- an OAuth authorization server. Cloudflare Access plays that role;
- a place where an AI can approve its own actions. Production approvals come from a
  separately authenticated human channel (A.3 B12).

### A.2 Verified vs assumed

**Verified 2026-09-15 against primary sources** (links in ARCHITECTURE.md / CLOUDFLARE.md):

1. The MCP current revision is **2026-07-28**: stateless, `server/discover` mandatory,
   no `initialize`, no sessions, no GET stream, required `Mcp-Method`/`Mcp-Name`
   headers, `Origin` validation MUST. Sampling, Roots, and Logging are deprecated.
2. Official TS SDK **v2.0.0** (`@modelcontextprotocol/server`, `/node`, `/client`, …)
   implements 2026-07-28. `createMcpHandler` serves 2025-era clients statelessly by
   default. It verifies no tokens and no Host/Origin headers itself; guards are mounted
   in front of it. v1 (`@modelcontextprotocol/sdk` 1.30) is on bug-fix/security
   support.
3. Claude Code 2.1.272 is on the VM. Its v2 runtime (default ≥ 2.1.232 with a
   first-party login) negotiates 2026-07-28 with HTTP servers. Its v1 runtime speaks
   only 2025-11-25. `MCP_SDK_GENERATION` / `MCP_PROTOCOL_NEGOTIATION` are documented on
   the Claude Code MCP page and present in the installed binary. It supports DCR and
   CIMD, and discovers RFC 9728 → RFC 8414.
4. Cloudflare Access **Managed OAuth** makes Access an OAuth 2.0 authorization server
   for an application. Tokens are opaque; the origin gets `Cf-Access-Jwt-Assertion`.
   It is incompatible with origins that send their own OAuth challenges.
5. Access JWT claims: user logins carry `aud` (array), `email`, `exp`, `iat`, `nbf`,
   `iss`, `type`, `identity_nonce`, `sub` (user ID), `country`. Service-token logins
   carry `type`, `aud`, `exp`, `iss`, `common_name` (= service-token Client ID), `iat`,
   and `sub` = empty string.
6. Cloudflare API MCP (`https://mcp.cloudflare.com/mcp`): `search`/`execute` Code
   Mode. `execute` can mutate, and the credential is its only restriction.
   IP-filtered tokens aren't supported.
7. `telosnexus.cloud` is on Cloudflare DNS. `mcp.telosnexus.cloud` has no record.
8. VM: Ubuntu 20.04 (out of standard support), arm64, Node 24.20.0, systemd 245 (no
   `LoadCredential=`), cgroup v1, no Docker, cloudflared 2026.9.1, NTP synchronized,
   swap 100% used, port 8787 free. **The `ubuntu` user (under which AI agent CLIs run)
   has passwordless sudo.**
9. GitHub: self-hosted runners "should almost never be used for public repositories".
   Environments with required reviewers are available for public repos on Free.
   Secret scanning and push protection are automatic for public repos.
10. Toolchain on linux-arm64: TypeScript 7.0.2, Biome 2.5.13, Vitest 5.0.0, pnpm 12.4.1
    installed and ran (Phase 1 gate).

**Assumed.** Each assumption has a named test and the phase that runs it:

| # | Assumption | If wrong, the cost | Cheapest test | Phase |
| --- | --- | --- | --- | --- |
| S1 | Claude Code completes Access Managed OAuth end to end (incl. RFC 8707 `resource`) against **our own Access app** | **Highest.** The auth design changes (fallback: MCP portal in front) | WP 4.0 step B: Managed OAuth app over a throwaway Worker. Step A (portal) is only a cheaper first signal | 4 |
| S2 | Access forwards `Cf-Access-Jwt-Assertion` for Managed OAuth and service-token requests, and the claims match A.2 #5 | Gateway auth design changes | WP 4.0 step B origin dumps claim *names* (not values) | 4 |
| S3 | The Telos Zero Trust plan includes Managed OAuth and MCP portals | Fall back to service tokens for all clients | Owner checks the dashboard | 4 |
| S4 | `node:sqlite` (Node 24) works for the approvals store: WAL, `busy_timeout`, and a concurrent CLI + gateway writer, without native deps | Swap to a JSON-file store with advisory locks | WP 3.3 spike test | 3 |
| S5 | The official `cloudflare` SDK v7 covers all Phase 5 read endpoints | Some tools use raw `GET` paths through the same GET-only client | WP 5.1 | 5 |
| S6 | 512 MB is enough for the gateway under the VM's memory pressure, and `MemoryMax=` is enforced on this cgroup-v1 host | Raise the limit, trim, or use `MemoryLimit=` | WP 6.2 check + WP 6.4 soak | 6 |
| S7 | The upstream Cloudflare API MCP accepts a server-side bearer token from an SDK v2 client and `search` works without account access | Drop the upstream adapter; curated tools only | WP 5.0: script, SDK client + Token B, call `search` | 5 |
| S8 | With Managed OAuth, Access serves both `/.well-known/oauth-protected-resource` (RFC 9728) and `/.well-known/oauth-authorization-server` on the app hostname, so the gateway serves neither | Gateway must serve PRM; route table and S1 change | WP 4.0 step B: `curl` both paths | 4 |
| S9 | Claude Code sessions survive past the Access access-token lifetime (refresh tokens issued to DCR/CIMD clients) | Re-login every ~15 min; raise lifetime or change client strategy | WP 4.0 step B: keep a session > 20 min, call a tool again | 4 |
| S10 | A CI-built release artifact with GitHub build-provenance attestation can be verified on the VM without the owner's GitHub credentials | Keep the rebuild-and-test-on-host deploy (baseline) | WP 8.6 spike | 8 |

### A.3 Boundaries and how each is enforced

Strongest mechanism first. A boundary backed only by prose is marked as such and
tracked to be hardened.

| # | Boundary | Enforcement | Strength | From |
| --- | --- | --- | --- | --- |
| B1 | Only `servers/gateway` imports the MCP **server** SDK | Other packages don't list `@modelcontextprotocol/server`; `scripts/check-boundaries.mjs` fails CI on any import of it outside `servers/gateway` | Structural + gate | 2 |
| B2 | Every tool goes through the policy wrapper | `check-boundaries.mjs` also fails on any SDK registration call (`registerTool`, `registerResource`, `registerPrompt`, `.tool(`) outside `servers/gateway/src/policy-wrapper.ts`; a test asserts the registered tool set equals the policy registry | Gate + test | 2 / 3 |
| B3 | Read tools can't mutate | Read tools receive a **GET-only** provider client (the type exposes only `get`/`list`; a test asserts no other HTTP method is ever issued), and their token has only read permission groups | Structural (type + credential) | 5 |
| B4 | Destructive ops need a human approval | Registry test: `risk: 'destructive'` ⇒ `approval: 'always'`; the policy engine has no bypass flag; approval binding tests (args hash, precondition, principal, expiry, single use) | Test + runtime | 3 |
| B5 | No token passthrough | After authentication the gateway removes `authorization`, `cookie`, `cf-access-*` from anything downstream; `ctx` exposes no raw request; test asserts a provider handler can't observe the inbound credential | Structural + test | 4 |
| B6 | Gateway listens on loopback only | Config schema rejects a non-loopback `TN_MCP_HOST`; test for the schema; `preflight.sh` asserts via `ss -tlnp` that 8787 is bound to `127.0.0.1` only. (No systemd `IPAddressDeny`: it would also block provider egress) | Runtime + test + gate | 2 / 6 |
| B7 | The dev authenticator is never reachable from outside | `TN_AUTH_MODE` is explicit (`access` \| `dev`). `dev` is refused unless `NODE_ENV=development` **and** `TN_MCP_PUBLIC_URL` is unset or a loopback URL; `preflight.sh` refuses to deploy anything but `access`. Loopback bind alone is **not** isolation, because a tunnel forwards to loopback | Runtime + test + gate | 2 / 6 |
| B8 | No secrets in the repo | GitHub push protection + secret scanning (server-side); `scripts/guard-secrets.mjs` in `pnpm run check` and CI | Strong + weak | 1 |
| B9 | CI can't touch the VM or secrets | GitHub-hosted runner only; `permissions: contents: read`; no secrets referenced; deploy is pull-based | Structural | 1 |
| B10 | Upstream Cloudflare API MCP can't mutate through the gateway | Only its `search` tool (OpenAPI-spec search, no account API calls) is exposed; `execute` is not proxied. The adapter's allowlist of upstream tool names is a constant, and a test fails if the adapter forwards any other name. The adapter only imports the read-token loader | Structural + test | 5 |
| B11 | Existing VM services are untouched | `deploy.sh`/`rollback.sh`/`preflight.sh` operate only on units matching `tn-mcps-*` and refuse any other name; the rest is prose (this plan, CLAUDE.md) | Gate + prose | 6 |
| B12 | A production approval can't be granted by the requesting client or an agent's session | Approvals are decided only through a **separate Access application** (`approve.telosnexus.cloud`) with its own AUD tag, owner-only policy, IdP MFA, and short session. The gateway accepts a decision only with an Access JWT whose `aud` is the approvals AUD and whose identity is a human `admin` who isn't the requester. MCP-app tokens can't satisfy that audience check. The local CLI can `list`/`show`/`deny` but can only `approve` when `NODE_ENV≠production` | Structural (audience) + runtime + test | 3 / 8 |
| B13 | Residual: an agent running as `ubuntu` on the VM (passwordless sudo) can read provider tokens and bypass every local control | **Not enforced by TN-MCPs.** Mitigation is an owner decision (Q11) that must be made before Phase 9: agents on the VM run as a non-sudo user, or passwordless sudo is removed. Until then, write-capable credentials must not exist on the VM | Owner policy | 9 |

### A.4 Build direction

**Bottom-up with one early top-down probe.** The substrate (gateway core, policy,
audit, auth) is built and tested locally before any provider or exposure. The single
top-down probe is the **Phase 4 auth spike**. It tests S1/S2/S8/S9 against real
Claude Code before we build on them. Every stand-in is replaced by a numbered
phase:
- the dev authenticator (Phase 2) is replaced for all deployed use by the Access
  verifier (Phase 4);
- the non-production CLI approval (Phase 3) is replaced for production by the
  approvals app (Phase 8).

### A.5 Why this phase order differs from the original suggestion

The original suggestion was Auth → Cloudflare read → Policy/Audit → Writes → Tunnel.
This plan uses Gateway → **Policy/Audit** → Auth → Cloudflare read → **Tunnel** →
Claude Code → **Operational readiness** → **Writes**:

- **Policy and audit come before the first provider tool,** so no provider code path
  ever exists outside the chokepoint (B2).
- **Writes come after operational readiness**: failure-mode handling, alerting,
  off-box audit, a tested restore, and the production approval channel. The first
  mutation of real infrastructure happens with all of those in place.
- **The auth spike runs before providers,** because S1 is the assumption whose failure
  costs the most rework.

### A.6 Gate conventions

- Every phase's gate starts with `pnpm run check` (exit 0, test count not lower than
  the previous phase).
- Phase-specific gates are listed per phase. Live checks against the public hostname
  happen only in phases where the owner approved exposure.
- "Done" means: the landing engineer ran the gate and read its output, the commit is
  on `main`, and the phase's exit criteria are ticked in this file.

### A.7 Cross-cutting contracts (decided now so implementers don't diverge)

**Tool definition** (`packages/core`, Phase 2):

```ts
interface ToolDefinition<I extends z.ZodType> {
  name: string;                         // <provider>_<verb>_<object>, ASCII snake_case
  provider: string;
  risk: 'read' | 'write' | 'destructive';
  scopes: string[];                     // e.g. ['cloudflare:dns:write']
  approval: 'never' | 'policy' | 'always';   // destructive ⇒ 'always' (B4)
  input: I;                             // zod v4; must NOT contain `approval_id`
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  resources?(args: z.infer<I>): ResourceRef[];            // what the call touches, for policy rules
  precondition?(args: z.infer<I>, ctx: ToolContext): Promise<{ stateHash: string; summary: string }>;
  handler(args: z.infer<I>, ctx: ToolContext): Promise<ToolResult>;
}
type ResourceRef = { kind: string; id: string; environment?: 'production' | 'staging' | 'unknown' };
```

**Approval contract** (Phase 3 store, Phase 8 production channel):

- Gated tools get a reserved optional argument **`approval_id`**, added by the policy
  wrapper (never by providers). The model can only control arguments, so that's the
  only transport every client supports. `approval_id` is **excluded** from the args
  hash by definition.
- `argsHash = sha256(JCS(parsedArgs without approval_id))`, where JCS is RFC 8785 JSON
  Canonicalization applied to the zod-parsed value (defaults applied).
- An approval binds: `principalId`, `tool`, `argsHash`, `preconditionHash` (from
  `precondition()` if defined), `policyVersion`, `gatewayRelease`, `expiresAt`
  (default 15 min). A pending approval from a different `gatewayRelease` is expired on
  startup.
- State machine: `pending → approved → executing → consumed`, or `pending → denied`,
  `pending|approved → expired`. `approved → executing` is one transaction taken
  **before** the provider call. A crash leaves `executing`, which becomes
  `unknown_outcome` on startup, is alerted, and is **never retried automatically**.
- Right before execution the gateway re-runs `precondition()`. A differing
  `stateHash` refuses the call (the approval becomes `expired`, and the result tells
  the model that state changed and a new approval is needed).
- The approver sees the **full, unredacted semantic arguments**, the precondition
  summary/diff, the requester identity, and the policy reason. Tools never accept
  secrets as arguments, so nothing secret is shown. Redaction applies to logs and
  audit only.

**Result-size contract** (Phase 2, enforced by the wrapper): serialized tool results
are capped at **48 KiB** (~12k tokens, under Claude Code's 25k default). List tools
take `cursor` and `limit` (default 50, max 200) and return
`{ items, nextCursor, truncated }`. When the cap bites, the wrapper truncates items
and sets `truncated: true`. It never silently drops data.

**Audit contract** (Phase 3): one record per line, JCS-serialized; fields `v`, `ts`,
`seq`, `keyId`, `prevHash`, `hmac`, `correlationId`, principal (`kind`, `id`),
`clientInfo`, `tool`, `risk`, redacted `args`, `decision`, `approvalId?`, `outcome`,
`durationMs`, `upstreamRequestIds`. The chain continues across daily files (the first
record of day N+1 carries the hash of day N's last record). A single writer (the
gateway process) appends with fsync. A partial last line found at startup is kept,
and a `recovery` record is appended that names it. If the intent record can't be
written (disk full, I/O error), the call is refused.

**Failure-mode defaults** (Phase 2 onward; Phase 8 tests them by injection):

| Condition | Behavior |
| --- | --- |
| Secret file missing, unreadable, or wrong mode at startup | Refuse to start; journald names the variable, not the value |
| JWKS fetch fails | Keep verifying with keys fetched within the last 24 h. An unknown `kid` is rejected |
| Access down | Edge rejects; gateway sees nothing. Runbook: status page check, no gateway restart |
| Audit write fails | Refuse the call (`isError`, "audit unavailable") and alert |
| Approvals store locked or busy > 5 s | Gated calls refused; read tools unaffected |
| Provider timeout (10 s default) / 5xx | `isError` with a retry hint; writes are never auto-retried |
| Clock not synchronized (`timedatectl`) | `preflight.sh` refuses to deploy; the gateway logs a warning each minute |
| Rate limits | In-memory token bucket per principal; **resets on restart**, accepted and documented (destructive ops are approval-gated regardless) |

---

## Part B: Phases

Each phase: Goal · Why · Architecture decisions · Files/dirs · Dependencies ·
Tasks (work packages, each with its gate) · Security requirements · Tests ·
Acceptance criteria · Rollback · Required user actions · Must NOT happen · Exit criteria.

---

### Phase 0: Discovery, VM audit, research ✅ (2026-09-15)

- **Goal:** establish verified facts about the host, protocols, and platforms before
  designing anything.
- **Why:** the spec (2026-07-28), the SDK (v2), and Claude Code's runtime split all
  changed within the last months. Designing from memory would have produced a
  2025-era stateful server.
- **Outcome:** VM audit in DEPLOYMENT_A1 §1. Research captured in ARCHITECTURE,
  CLOUDFLARE, CLAUDE_CODE, and SECURITY, with sources. Two independent design
  critiques adjudicated (Part D).
- **Must NOT happen (held):** no Cloudflare/GitHub API calls with credentials, no
  service changes, no secrets printed. Existing secret files were reported by location
  only, in the session report, and are not in this public repo.
- **Exit criteria:** ✅ documents written, ✅ assumptions listed (A.2).

---

### Phase 1: Repository foundation (this session)

- **Goal:** a public-safe pnpm/TypeScript monorepo with one real gate, CI on
  GitHub-hosted runners, secret guard, documentation set.
- **Why:** every later phase lands through this gate.
- **Architecture decisions:** Node 24 LTS; TypeScript 7 strict ESM/NodeNext; pnpm 12
  workspaces (`packages/*`, `providers/*`, `servers/*`); Biome 2; Vitest 5 projects from
  the root; `tsc -b` project references; dependency build scripts blocked.
- **Files:** root configs, `packages/shared/**`, `scripts/guard-secrets.mjs`,
  `.github/**`, `README.md`, `CLAUDE.md`, `.mcp.json`, `.env.example`, `docs/*`.
- **Dependencies:** typescript 7.0.2, @biomejs/biome 2.5.13, vitest 5.0.0,
  @types/node 24.x, zod 4.6.5.
- **Work packages:**
  - WP 1.1 Tooling + `@tn-mcps/shared` (`redact`, `loadConfig`) + guard + CI.
    Gate: `pnpm install --frozen-lockfile && pnpm run check`. ✅ 18 tests.
  - WP 1.2 Documentation set. Gate: `pnpm run check` (the guard scans docs too).
- **Security requirements:** CI `permissions: contents: read`, SHA-pinned actions,
  `persist-credentials: false`, no `pull_request_target`, no self-hosted runner;
  `.mcp.json` credential-free; `redact()` output always JSON-serializable and handles
  Error/class instances; `ConfigError` never contains received values.
- **Tests:** redaction (keys, token-shaped values, cycles vs shared refs, depth,
  Error/Map/Set/URL/binary), config (no value leak), guard (finding without echo,
  clean tree, ignored `.env`, deleted tracked file).
- **Acceptance:** gate green locally **and** in the first CI run on GitHub.
- **Rollback:** repo-only; revert commits.
- **Required user actions:** Owner Actions §1.
- **Must NOT happen:** production changes, credentials anywhere in the tree, a
  self-hosted runner.
- **Exit criteria:** bootstrap commits on `main`; CI green on GitHub; Owner Actions §1
  applied or scheduled.

---

### Phase 2: Gateway core (local only)

- **Goal:** `servers/gateway`, a dual-era MCP server on `127.0.0.1`, built on the tool
  contract (A.7), with one harmless tool, proven with the official SDK client in both
  eras.
- **Why:** the protocol layer must be correct before anything depends on it.
- **Architecture decisions:**
  - `createMcpHandler(factory)` from `@modelcontextprotocol/server` 2.0.0, mounted on
    `node:http` via `toNodeHandler` from `@modelcontextprotocol/node` 2.0.0 (peer
    `hono`). `hostHeaderValidation([publicHost, '127.0.0.1', 'localhost'])` and
    `originValidation([publicHost])` go in front, with a missing `Origin` allowed
    (non-browser clients). No Express.
  - Legacy mode `'stateless'` (default). `responseMode: 'json'` initially.
  - Routes: `POST /mcp`; `GET /healthz` (no auth, `{status, version}` only); everything
    else `404`. **S8 may add** `/.well-known/oauth-protected-resource/mcp` after Phase 4;
    the route table lives in one module so that's a one-line change.
  - `packages/core`: A.7 `ToolDefinition`, `defineTool()`, `Principal`, `ToolContext`,
    `ToolRegistry` (sorted, rejects duplicates and any `input` containing `approval_id`).
  - Authenticator interface. Phase 2 ships `DevTokenAuthenticator` only (B7 rules):
    token from `TN_DEV_TOKEN_FILE`.
  - Secret-file rule (shared helper in `@tn-mcps/shared`): the file must be a regular
    file, not world-readable, and either owner-only (`0600`) or `0640` with the group
    equal to the service's group. Otherwise refuse to start.
  - Structured logging: `pino` to stderr; every logged object goes through `redact()`.
  - Tool: `telos_server_info` (read): gateway version, spec revision, enabled providers.
  - Result-size contract (A.7) enforced in the wrapper stub.
- **Files:** `packages/core/**`, `servers/gateway/**`, `scripts/check-boundaries.mjs`,
  root `tsconfig.json` references, `.env.example` (`TN_AUTH_MODE`, `TN_DEV_TOKEN_FILE`).
- **Dependencies:** `@modelcontextprotocol/server@2.0.0`, `@modelcontextprotocol/node@2.0.0`,
  `hono` (^4.11.4), `pino@10`; dev: `@modelcontextprotocol/client@2.0.0`.
- **Work packages:**
  - WP 2.1 `packages/core` contract + registry + secret-file helper.
    Gate: `pnpm run check`.
  - WP 2.2 `servers/gateway`: HTTP server, config schema (B6/B7), guards, health, dev
    authenticator, `telos_server_info`, result cap. Gate: `pnpm run check`.
  - WP 2.3 E2E with the real SDK client over real HTTP on an ephemeral loopback port:
    (a) `versionNegotiation: {mode: 'auto'}` lands on `modern`; (b) default client lands
    on `legacy`; (c) both call `telos_server_info`; (d) `Host: 127.0.0.1:<port>`
    accepted, `Host: evil.example` → 403, foreign `Origin` → 403, absent `Origin`
    accepted; (e) no or invalid token → 401; (f) GET/DELETE `/mcp` → 405 and
    `Mcp-Session-Id` ignored, never echoed; (g) config rejections: `TN_MCP_HOST=0.0.0.0`;
    `TN_AUTH_MODE=dev` with `NODE_ENV=production`; `dev` with a non-loopback
    `TN_MCP_PUBLIC_URL`; world-readable token file. Gate: `pnpm run check`.
  - WP 2.4 `scripts/check-boundaries.mjs` (B1 + B2 call-site rule) in `check`.
    Gate: `pnpm run check`, plus a probe (forbidden import and a stray `registerTool`
    in a temp copy) showing the script fails.
- **Security requirements:** loopback bind; Host/Origin validation; body limit 1 MiB;
  request timeout 30 s; no stack traces in responses; `X-Accel-Buffering: no` on SSE.
- **Acceptance:** both eras pass E2E on CI; the boundary probe fails as expected.
- **Rollback:** repo-only.
- **Required user actions:** none.
- **Must NOT happen:** binding 0.0.0.0; provider credentials; deployment; `dev` auth
  reachable outside development.
- **Exit criteria:** WPs 2.1–2.4 landed; B1, B2 (call-site half), B6, B7 enforced.

---

### Phase 3: Policy, audit, approvals framework

- **Goal:** every tool call passes authorization → policy → approval check →
  audit-intent → execution → audit-outcome. Destructive actions are impossible without
  a bound, single-use approval.
- **Why:** the chokepoint exists before the first provider (A.5).
- **Architecture decisions:** A.7 approval, audit, and failure contracts, plus:
  - `packages/policy`: role → scopes map; `evaluate(principal, def, args, resources)
    → allow | deny(reason) | approval_required(reason)`; rules can match
    `ResourceRef.environment` (e.g. production ⇒ approval for `write`).
    `destructive ⇒ approval` is code, not data. `policyVersion` = hash of the rule set.
  - `packages/audit`: A.7 audit contract; `keyId` supports HMAC key rotation (old keys
    kept read-only for `verify`); `tn-mcps audit verify [--from DATE]`.
  - `packages/approvals`: `node:sqlite` (S4), WAL, `busy_timeout=5000`,
    `schema_version` table, the A.7 state machine in transactions. CLI
    `tn-mcps approvals list|show|deny` everywhere; `approve` only when
    `NODE_ENV≠production` (B12). Every CLI action is audited through the gateway's
    store API.
  - `servers/gateway/src/policy-wrapper.ts`: the single registration site (B2). It adds
    `approval_id` to gated tools, computes `argsHash`, runs `precondition()` at request
    and execution time, emits `isError: true` +
    `{status:'approval_required', approvalId, expiresAt, summary}`.
  - Tools with `risk ≥ write` carry `_meta: {"anthropic/requiresUserInteraction": true}`
    and annotations consistent with their risk (registry test).
- **Files:** `packages/policy/**`, `packages/audit/**`, `packages/approvals/**` (+ `bin`),
  `servers/gateway/src/policy-wrapper.ts`.
- **Dependencies:** none external if S4 passes; `canonicalize` (RFC 8785) or an
  in-repo JCS implementation with test vectors from the RFC.
- **Work packages:**
  - WP 3.1 `packages/audit` + verify CLI. Gate: `pnpm run check`.
  - WP 3.2 `packages/policy`. Gate: `pnpm run check`.
  - WP 3.3 `packages/approvals` + CLI (S4 spike first, including two concurrent
    writers). Gate: `pnpm run check`.
  - WP 3.4 `policy-wrapper` + gateway integration + test-only tools
    (`test_destructive_noop` with a `precondition` over an in-memory value).
    Gate: `pnpm run check`.
- **Security requirements:** approval IDs are random 128-bit and not authentication
  (bound to principal); the store holds `argsHash` + redacted summary, not raw args;
  no configuration can relax `destructive ⇒ always`.
- **Tests:** chain tamper detection (edit, delete, reorder, truncate, cross-day gap,
  wrong `keyId`); JCS vectors; args-hash binding (changed arg → rejected; `approval_id`
  excluded); precondition change between approval and execution → refused; expiry;
  replay (second use rejected); self-approval rejected; release change expires
  pending; crash in `executing` → `unknown_outcome`; registry invariants (B4,
  annotations); missing scope → `isError` naming the scope; audit-intent failure →
  not executed.
- **Acceptance:** E2E: `test_destructive_noop` → approval_required → non-production CLI
  approves → re-call with `approval_id` executes once → second re-call refused →
  `audit verify` passes → a tampered file fails verify.
- **Rollback:** repo-only.
- **Required user actions:** none.
- **Must NOT happen:** an "approve all", a TTL-less approval, an approval path in
  production that doesn't go through B12.
- **Exit criteria:** WPs 3.1–3.4 landed; B2 (test half) and B4 enforced.

---

### Phase 4: Authentication and authorization (Cloudflare Access)

- **Goal:** the gateway authenticates real Access identities and maps them to roles,
  and the Claude Code ↔ Access Managed OAuth path is proven before anything depends on it.
- **Why:** S1 is the most expensive assumption.
- **Architecture decisions:**
  - `packages/auth` `AccessJwtAuthenticator` (`jose` 6.x `createRemoteJWKSet` on
    `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`). Required: `alg`
    RS256 only; `iss` = team domain exactly; `aud` (array) **contains** the configured
    AUD; `exp`/`iat` valid (60 s tolerance); `type === 'app'`.
  - **Principal contract (reject everything else):**
    - human ⇔ `email` present **and** `sub` non-empty **and** no `common_name`. Email is
      lowercased and compared to `TN_ALLOWED_EMAILS`. The stable principal ID is `sub`.
    - service ⇔ `common_name` non-empty **and** `sub === ''` **and** no `email`.
      `common_name` must be in `TN_ALLOWED_SERVICE_TOKEN_IDS`. Principal ID
      `svc:<common_name>`.
    - Unknown or ambiguous shape → 401, audited as `auth_rejected` with the claim
      *names* seen.
  - Roles from the server-side role map. An unlisted identity is denied, not
    defaulted to `viewer`.
  - B5 header stripping. No own `WWW-Authenticate` in Access mode (plain 401/403).
  - JWKS cache per A.7 failure defaults.
- **Files:** `packages/auth/**`, gateway auth wiring, `.env.example`.
- **Dependencies:** `jose@6.2.x`.
- **Work packages:**
  - WP 4.0 **Auth spike (owner + Claude).**
    Step A (zero infrastructure): owner creates an MCP portal with only the public
    Cloudflare Docs server; Claude connects Claude Code and calls a docs tool.
    Step B (the real test, owner-approved throwaway): an Access app with Managed OAuth
    on `mcp-spike.telosnexus.cloud` fronting a throwaway Worker running a minimal SDK v2
    MCP handler that returns the Access claim **names** it received. Claude records S1
    (Claude Code completes OAuth), S2 (claim names), S8 (which `/.well-known/*` Access
    serves), and S9 (session still works after > 20 min). Owner deletes the app, the
    Worker, and the hostname afterwards.
    Gate: `claude mcp list` shows `✔ Connected` for the spike, and one tool call
    succeeds before and after 20 minutes. Findings are recorded in A.2.
  - WP 4.1 Verifier with tests against a locally generated JWKS (real `jose`
    verification): valid human; valid service; wrong `aud`; `aud` array without ours;
    wrong `iss`; expired; `alg: none`; HS256; unknown `kid` → refetch; JWKS down with a
    fresh cache → accepted; JWKS down with an unknown `kid` → rejected; ambiguous shapes
    (email + common_name; empty everything) → rejected. Gate: `pnpm run check`.
  - WP 4.2 Principal/role mapping, B5 stripping, and a test that a provider handler
    can't see the inbound credential. Gate: `pnpm run check`.
- **Security requirements:** never log the JWT; audit `sub`/`email`/`common_name` only.
- **Acceptance:** spike outcomes recorded (or the fallback chosen and ARCHITECTURE
  updated); verifier tests green.
- **Rollback:** spike resources deleted by the owner; code is repo-only.
- **Required user actions:** Owner Actions §2.
- **Must NOT happen:** building our own OAuth AS; accepting the opaque `oauth:` token
  at the origin; changing existing Telos Access applications.
- **Exit criteria:** S1, S2, S3, S8, S9 resolved in A.2; WPs 4.1–4.2 landed.

---

### Phase 5: Cloudflare read-only provider

- **Goal:** the seven Telos read tools plus `cloudflare_api_search`, working against the
  real account with read-only tokens.
- **Why:** first useful capability, with no ability to mutate (B3, B10).
- **Architecture decisions:**
  - `providers/cloudflare`: curated tools on the official `cloudflare` SDK 7.x, wrapped
    in a **GET-only client** (B3); result-size contract (A.7); summarised output (IDs,
    names, statuses, counts).
  - Upstream adapter: `@modelcontextprotocol/client` 2.0.0 →
    `https://mcp.cloudflare.com/mcp` with the server-side Token B. Only upstream tool
    `search` is forwarded, as `cloudflare_api_search` (B10). `execute` isn't exposed.
    If it is ever needed, it returns as a separate `write`-class tool behind approvals.
  - Tools, endpoints, and tokens: CLOUDFLARE §3–4.
- **Files:** `providers/cloudflare/**`, gateway provider registration, `.env.example`.
- **Dependencies:** `cloudflare@7.1.x`, `@modelcontextprotocol/client@2.0.0`.
- **Work packages:**
  - WP 5.0 S7 spike (owner-approved, needs Token B on the VM): a script calls upstream
    `search` once. Gate: exit 0 and a non-empty result.
  - WP 5.1 Curated read tools with an HTTP-level fake (undici `MockAgent`) asserting
    method = GET, path, query, and auth-header **presence**; recorded-shape fixtures;
    cursor/limit/truncation. Gate: `pnpm run check`.
  - WP 5.2 Upstream adapter with a local fake MCP server (real SDK) asserting it gets the
    server-side credential, never the inbound one, and that a non-allowlisted tool name
    is refused. Gate: `pnpm run check`.
  - WP 5.3 Live read-only smoke on the VM, owner-approved:
    `pnpm --filter @tn-mcps/provider-cloudflare run smoke` (zone and tunnel counts with
    Token A). Gate: exit 0; IDs appear in the terminal only.
- **Security requirements:** tokens only via `*_FILE` paths and the secret-file rule;
  Cloudflare errors mapped without token text; tunnel tokens and Worker script bodies
  never returned.
- **Tests:** as in the WPs; plus 401/403 from Cloudflare → `isError` naming the
  missing permission group.
- **Acceptance:** all tools pass tests; S5 and S7 resolved; live smoke OK.
- **Rollback:** `TN_PROVIDERS=` (disable); owner revokes the tokens.
- **Required user actions:** Owner Actions §3.
- **Must NOT happen:** any write-capable token; tokens in chat; running the smoke
  without a go-ahead; proxying upstream `execute`.
- **Exit criteria:** WPs 5.0–5.3 done.

---

### Phase 6: Private ingress (dedicated tunnel, `mcp.telosnexus.cloud`, Access)

- **Goal:** the gateway runs as a hardened systemd service, reachable only through
  Cloudflare Access at `https://mcp.telosnexus.cloud/mcp`, serving **read-only** tools.
- **Why:** first production exposure, only after auth and read tools are proven.
- **Architecture decisions:** DEPLOYMENT_A1 §2–4 and CLOUDFLARE §5–6 (users `tnmcp` /
  `tnmcp-tunnel`, split config dirs, system cloudflared, new remotely-managed tunnel
  `tn-mcps`, Access app with Managed OAuth, pull-based deploy with the trust chain in
  DEPLOYMENT_A1 §4).
- **Files:** `deploy/systemd/*.service`, `deploy/cloudflared/README.md`,
  `deploy/scripts/{preflight,deploy,rollback}.sh`.
- **Dependencies:** official cloudflared package at `/usr/local/bin/cloudflared`.
- **Work packages:**
  - WP 6.1 Scripts. `preflight.sh`: port free or ours; clock synced; `TN_AUTH_MODE=access`;
    file ownership/modes per DEPLOYMENT_A1 §2; unit-name allowlist (B11). `deploy.sh
    <sha>`: DEPLOYMENT_A1 §4 trust chain, on-host `pnpm run check`, atomic switch,
    health, auto-rollback, schema-version check. `rollback.sh`.
    Gate: `bash -n` on each + CI dry-run against a temp prefix with a fake `systemctl`.
  - WP 6.2 Host provisioning, **owner-approved, on the VM**: users, directories, units,
    `daemon-reload`, enable **gateway only**; `curl -fsS 127.0.0.1:8787/healthz`; S6
    check that `MemoryMax` shows up in the unit's cgroup
    (`systemctl show -p MemoryMax`, cgroup `memory.limit_in_bytes`).
    Gate: health 200; `ss -tlnp` shows `127.0.0.1:8787` only.
  - WP 6.3 Tunnel + DNS + Access, **owner in dashboard, Claude verifies**: tunnel
    `tn-mcps` with published app `mcp.telosnexus.cloud → http://127.0.0.1:8787` +
    catch-all 404; token file placed; Access app (Managed OAuth, owner Allow policy).
    Claude enables `tn-mcps-tunnel.service`.
    Gate: unauthenticated `POST` → 401 from Access with `WWW-Authenticate`;
    `claude mcp add --scope local …` + login → `telos_server_info` works; a loopback
    request without a JWT → 401 from the gateway.
  - WP 6.4 Minimal external liveness alert (a free external uptime check on
    `/healthz` through a separate Access-bypass path is **not** allowed, so the owner's
    existing monitoring pings `https://mcp.telosnexus.cloud/mcp` and alerts on a
    non-401 answer), plus a 24 h soak: RSS ≤ 256 MB, no restarts, no errors.
- **Security requirements:** no inbound port; tunnel token readable only by
  `tnmcp-tunnel`; gateway secrets readable only by `tnmcp`; optional staging host (Q10).
- **Acceptance:** WP 6.3 gates; soak clean; rollback rehearsed once.
- **Rollback:** `systemctl disable --now tn-mcps-tunnel tn-mcps-gateway`; owner deletes
  the tunnel route and the Access app. The existing Telos tunnel is unaffected by
  construction.
- **Required user actions:** Owner Actions §4.
- **Must NOT happen:** touching the existing tunnel, its unit, or its DNS; opening
  ports; write tools; deploying without approval of that deploy.
- **Exit criteria:** endpoint live, read-only, Access-protected, alerting, soak clean.

---

### Phase 7: Claude Code production integration

- **Goal:** Claude Code sessions for this repo use the gateway by default with sane
  permissions.
- **Decisions:** add `telos` to `.mcp.json` (URL only); commit `.claude/settings.json`
  with `allow` for read tools and `ask` for write tools.
- **Files:** `.mcp.json`, `.claude/settings.json`, `docs/CLAUDE_CODE.md`.
- **WP 7.1** config + docs. Gate: `pnpm run check`; fresh clone → `claude mcp list`
  shows `telos` pending approval, then `✔ Connected` after approval + login.
- **Security requirements:** `.mcp.json` credential-free (guard-enforced). Headless
  `claude -p` loads project servers without asking, so only the gateway and public docs
  servers are listed.
- **Exit:** the owner connects from their own machine with only the committed config
  plus browser login.
- **Rollback:** remove the entry. **Required user actions:** Owner Actions §5.
- **Must NOT happen:** tokens in config; `bypassPermissions` recommendations.

---

### Phase 8: Operational readiness (gate for all writes)

- **Goal:** failure modes handled and tested, alerts working, audit off-box, restore
  proven, and the **production approval channel** (B12) live, all before any write.
- **Architecture decisions:**
  - Approvals app: a small authenticated page served by the gateway at a second route,
    published through the same tunnel as `approve.telosnexus.cloud` and protected by a
    **separate Access application** (owner-only policy, IdP MFA, session ≤ 10 min).
    The gateway accepts a decision only with an Access JWT carrying the approvals AUD
    and a human `admin` identity different from the requester (B12). The page shows the
    A.7 approval view. Decisions are audited. Optional: notify the owner (Q5) with a link.
  - Metrics on loopback (Prometheus text) and alerts: 5xx rate, auth rejections, audit
    failures, `unknown_outcome`, approval requests, disk usage > 80% on
    `/var/lib/tn-mcps`, clock unsynced.
  - Audit shipping: at most 15-minute lag to a dedicated R2 bucket with an
    **object-write-only, bucket-scoped** token on the VM. Restores use a separate
    **read-only** credential that lives off-VM with the owner. Local retention is 400
    days, compressed.
  - HMAC key rotation procedure with `keyId`.
- **Work packages:**
  - WP 8.1 Failure-injection tests for every row of A.7 failure defaults (missing
    secret, JWKS down, audit disk-full via a small tmpfs, sqlite lock, provider timeout,
    crash in `executing`). Gate: `pnpm run check`.
  - WP 8.2 Metrics + alerts. Gate: a test alert reaches the owner.
  - WP 8.3 Audit shipping + restore script. WP 8.4 Restore drill: restore into a temp
    dir with the off-VM credential; `audit verify` passes. The drill log is recorded here.
  - WP 8.5 Approvals app + Access app (owner). Gate: Codex's falsification test. As
    `tnmcp` and as `ubuntu`, including via a pseudo-TTY, try to approve a pending
    request without the approvals-app identity. Every attempt fails. The owner's
    MFA-backed browser approval succeeds.
  - WP 8.6 S10 spike: CI release artifact + build-provenance attestation, verified on
    the VM without owner credentials. If it works, `deploy.sh` switches to it.
- **Required user actions:** Owner Actions §6.
- **Must NOT happen:** backups containing token files; the backup credential able to
  read or delete; an approval path that bypasses B12.
- **Exit criteria:** all WPs pass; Q11 (agent sudo policy, B13) decided and applied.

---

### Phase 9: Cloudflare controlled writes

- **Goal:** `cloudflare_dns_upsert`, `cloudflare_dns_delete` (single record),
  `cloudflare_pages_deploy`, `cloudflare_worker_deploy`,
  `cloudflare_tunnel_route_update`, all behind policy, approvals, and audit.
- **Decisions:** Token C (CLOUDFLARE §4) injected only for write defs; each write
  defines `resources()` and `precondition()` (the current record/config hash);
  **dry-run diff** in the approval view; execution re-checks the precondition (A.7);
  idempotency: upserts are keyed by (zone, type, name) and re-applying identical
  content is a no-op; post-write read-back. A read-back mismatch after a successful
  write is reported as `isError` "applied but unverified", alerted, and never retried.
  The existing Telos tunnel's ID is on a config denylist for route updates.
- **Work packages:** one WP per tool (request-asserting fakes + approval E2E).
  Final WP: owner-approved live upsert and delete of a designated test record, audited.
  Gate per WP: `pnpm run check`.
- **Required user actions:** Owner Actions §7.
- **Must NOT happen:** zone deletion, nameserver change, R2/Worker/tunnel deletion tools
  (not built without a separately approved need); bulk ops without the destructive path;
  any write before Phase 8 exit.
- **Exit criteria:** all write tools landed; live test passed; audit shows the full
  trail.

---

### Phase 10: GitHub provider

- **Goal:** read tools (repos, PRs, workflow runs, security alerts) and controlled
  writes (issues, PR comments, workflow dispatch) via a **GitHub App** (installation
  tokens, 1 h), never a PAT.
- **Decisions:** compare proxying GitHub's official MCP server (read-only tool subset,
  as with B10) against Octokit curated tools. Same A.7 contracts.
- **Required user actions:** Owner Actions §8.
- **Must NOT happen:** repo deletion, visibility, secret, or ruleset changes without the
  destructive path.

### Phase 11: Oracle Cloud provider

- **Goal:** read tools (instances, VCN security lists, block volumes, budget) and
  guarded writes (start/stop instance) via the OCI TypeScript SDK with a
  least-privilege IAM user.
- **Must NOT happen:** terminate, security-list, or IAM changes without the destructive
  path. Any action on the A1 host itself is classified destructive (it would cut off
  the gateway).
- **Required user actions:** Owner Actions §9.

### Phase 12: Firebase provider

- **Goal:** read tools (projects, hosting releases, rules/index metadata) and guarded
  deploys with a minimal-role service account.
- **Required user actions:** Owner Actions §10.

### Phase 13: Telos internal tools

- **Goal:** tools for Telos Nexus internal systems (jobs API read endpoints,
  domain-watch status) through service-to-service credentials, never by reading another
  service's secrets or database.

### Phase 14: Jarvis integration

- **Goal:** Jarvis calls the gateway as a **service principal** (Access service token)
  with a restricted role. It may *relay* approval requests to the owner, but it can't
  approve: service principals can never satisfy B12.
- **Required user actions:** Owner Actions §11.

### Phase 15: OpenAI and other MCP clients

- **Goal:** verify the gateway with other remote-MCP clients (Codex CLI, OpenAI remote
  MCP, MCP Inspector) and record a compatibility matrix. Clients without interactive
  OAuth use service tokens.

---

## Part C: Open questions (each has an owner)

| # | Question | Owner | Needed by |
| --- | --- | --- | --- |
| Q1 | Does Claude Code complete Access Managed OAuth against our own app? (S1, S2, S8, S9) | Claude runs WP 4.0; Qasim creates the spike resources | Phase 4 |
| Q2 | Does the Telos Zero Trust plan include Managed OAuth and MCP portals, and what is the team domain? (S3) | Qasim | Phase 4 |
| Q3 | Which IdP does Access use for the owner (Google, GitHub, one-time PIN), and does it enforce MFA? | Qasim | Phase 4 (MFA needed by Phase 8) |
| Q4 | Which zones and records count as "production" for write approvals? | Qasim | Phase 9 |
| Q5 | Notification channel for alerts and approval requests: Telegram, Jarvis, or both? | Qasim | Phase 8 |
| Q6 | License for this public repo (currently none, meaning all rights reserved)? | Qasim | non-blocking |
| Q7 | Ubuntu 20.04: attach Ubuntu Pro (ESM) or schedule an OS upgrade? | Qasim | before Phase 6 |
| Q8 | The VM's egress IP for Token A's IP filter | Claude (public trace endpoint) | Phase 5 |
| Q9 | Where Jarvis stores its service-token secret | Qasim (Jarvis maintainer) | Phase 14 |
| Q10 | Staging hostname before production in Phase 6? | Qasim | Phase 6 |
| Q11 | **Agent sudo policy (B13):** run AI agent CLIs on the VM as a non-sudo user, or remove passwordless sudo from `ubuntu`? Without one of these, any local agent can read provider tokens directly | Qasim | before Phase 9 (strongly recommended before Phase 5) |

---

## Part D: Design review record

Two independent read-only critiques were run on revision 1 (2026-09-15): OpenCode
(GLM-5.3-flash, max) and Codex (GPT-5.6-Luna, high). Adjudication:

| Finding | Source | Decision |
| --- | --- | --- |
| Same-host CLI approval is self-approvable (pty bypass; `ubuntu` has passwordless sudo) | both | **Accepted.** B12 (separate Access app, audience separation, MFA); CLI approve is non-production only; B13 residual risk + Q11 |
| `IPAddressDeny=any` would block provider egress | both | **Accepted.** Removed; B6 now bind + schema + `ss` preflight |
| Tunnel-token ownership contradictory; parent-dir traversal | both | **Accepted.** Split `/etc/tn-mcps/{gateway,tunnel}` dirs; system cloudflared |
| `gh run list` proves little; reuses an out-of-scope credential | both | **Accepted.** DEPLOYMENT_A1 §4 trust chain via the public REST API, ancestry and tree checks, on-host full gate; attested artifact as S10 |
| TOCTOU between approval and execution | both | **Accepted.** `precondition()` in A.7 |
| `approval_id` transport and hashing unspecified; canonicalization undefined; approver sees redacted args | OpenCode | **Accepted.** A.7 (reserved arg excluded from hash, RFC 8785 JCS, full-args view) |
| B2 test tautological | OpenCode | **Accepted.** Call-site rule in `check-boundaries.mjs` |
| Dev authenticator exposable through the tunnel despite loopback | Codex | **Accepted.** B7 explicit `TN_AUTH_MODE`, public-URL rule, preflight |
| Upstream `execute()` read boundary rests on token config only | Codex | **Accepted.** Only `search` proxied (B10) |
| Access principal contract loose | Codex | **Accepted.** Phase 4 claim rules |
| Missing operational-readiness work before writes | Codex | **Accepted.** Phase 8 re-scoped as the write gate |
| Missing assumptions (upstream bearer, RFC 9728 owner, token lifetime) | OpenCode | **Accepted.** S7–S9; S10 added |
| Output cap/pagination, audit keyId/cross-day chain, sqlite concurrency, clock, symlink atomicity, rollback vs schema, restore credential | both | **Accepted.** A.7 contracts, DEPLOYMENT_A1 §4, Phase 8 |
| `MCP_SDK_GENERATION` / `MCP_PROTOCOL_NEGOTIATION` don't exist | Codex | **Rejected.** Documented on code.claude.com/docs/en/mcp and present in the installed 2.1.272 binary (the env-vars page fetch was truncated) |
| Prefer immutable CI artifact over an on-host rebuild | Codex | **Deferred** to WP 8.6 (S10). The baseline runs the full gate on the exact bytes it deploys |
| Add a separate operational-readiness phase | Codex | **Merged** into Phase 8 rather than adding a 17th phase; Phase 9 is blocked on it |

---

## Owner Actions Required

Everything below needs Qasim to act or approve. **Never paste a secret into chat.**
Where a value must reach the VM, the steps put it there directly. This command reads
from a hidden prompt, so nothing lands in shell history, logs, or chat:

```bash
# example for a gateway secret; directories and modes per DEPLOYMENT_A1 §2
read -rs -p 'Paste token, then Enter: ' T && printf '%s' "$T" | sudo tee /etc/tn-mcps/gateway/<name>.token >/dev/null && unset T
sudo chown root:tnmcp /etc/tn-mcps/gateway/<name>.token && sudo chmod 0640 /etc/tn-mcps/gateway/<name>.token
```

Detailed click-by-click instructions are written into the relevant phase when we reach
it. The GitHub steps (§1) are written out now because they apply immediately.

### §1 Now: GitHub repository settings (Phase 1)

On https://github.com/heisqasim/TN-MCPs:

1. **Settings → Code security** (may be titled "Advanced Security"):
   - *Secret scanning*: Enabled (automatic for public repos; confirm).
   - *Push protection*: Enable.
   - *Dependabot alerts*: Enable. *Dependabot security updates*: Enable.
2. **Settings → Actions → General:**
   - *Actions permissions*: allow actions; tick **Require actions to be pinned to a
     full-length commit SHA**.
   - *Approval for running fork pull request workflows from contributors*: **Require
     approval for all external contributors**.
   - *Workflow permissions*: **Read repository contents and packages permissions**.
     Untick **Allow GitHub Actions to create and approve pull requests**. Save.
3. **Settings → Rules → Rulesets → New ruleset → New branch ruleset** (after the first
   CI run completes, so the `check` status is selectable):
   - Name `main-protection`, Enforcement **Active**, Target: *Include default branch*.
   - Tick **Restrict deletions**, **Block force pushes**, **Require a pull request
     before merging** (0 approvals is fine for a solo owner), **Require status checks
     to pass** → add `check`. Create.
4. **Settings → Actions → Runners**: confirm no self-hosted runners. Never add this VM.
5. Decide a license (Q6).
6. Decide the agent sudo policy (Q11). Recommended: run AI agent CLIs on the VM under a
   dedicated non-sudo user before any Cloudflare token is placed on the VM (Phase 5).

### §2 Phase 4: Access and auth spike

- Confirm Zero Trust is active, and tell Claude the plan tier and **team domain** (not a
  secret, and not committed). Answers Q2.
- Choose the IdP for your login and make sure it enforces MFA (Q3).
- Step A: create a temporary MCP portal with only the Cloudflare Docs server upstream.
  Step B: approve and create the throwaway `mcp-spike.telosnexus.cloud` Access app
  (Managed OAuth) and Worker. Claude supplies exact steps then. Delete both afterwards.

### §3 Phase 5: Cloudflare read-only tokens

- Create **Token A** `tn-mcps-read` and **Token B** `tn-mcps-read-upstream` with the
  permission groups in CLOUDFLARE §4 (account-owned preferred; requires Super
  Administrator), TTLs as listed, IP filtering on Token A only.
- Place both on the VM with the hidden-prompt command
  (`/etc/tn-mcps/gateway/cloudflare-read.token`, `…/cloudflare-read-upstream.token`).
- Approve the S7 spike (WP 5.0) and the live read-only smoke (WP 5.3).

### §4 Phase 6: Hostname, tunnel, Access, host changes

- Approve the hostname **`mcp.telosnexus.cloud`** (and optionally a staging host, Q10).
- Approve host provisioning: users `tnmcp` and `tnmcp-tunnel`; `/opt/tn-mcps`,
  `/etc/tn-mcps/{gateway,tunnel}`, `/var/lib/tn-mcps`; the two `tn-mcps-*` units; the
  official cloudflared package.
- In the dashboard (steps supplied then): create the **new** tunnel `tn-mcps`,
  published application `mcp.telosnexus.cloud → http://127.0.0.1:8787` + catch-all 404;
  place its token as `/etc/tn-mcps/tunnel/tunnel.token`.
- Create the Access application for `mcp.telosnexus.cloud`: Managed OAuth on, Allow
  policy for your email, access token lifetime per the S9 result.
- Set up the external liveness alert (WP 6.4). Approve the first production deploy.
  Decide Q7.

### §5 Phase 7: Claude Code

- Approve adding `telos` to `.mcp.json` and the committed `.claude/settings.json`. Log in
  once from your own machine (`claude mcp login telos`).

### §6 Phase 8: Operational readiness

- Approve hostname **`approve.telosnexus.cloud`** and create its **separate** Access
  application (owner-only, MFA, session ≤ 10 min). Give Claude its AUD tag (not secret).
- Approve a dedicated R2 bucket (e.g. `tn-mcps-audit`), an **object-write-only** token
  scoped to it for the VM, and a **read-only** token for restores that you keep on your
  own machine, not the VM.
- Choose the notification channel (Q5). Apply the Q11 decision.

### §7 Phase 9: Writes

- List production zones/records (Q4) and a safe test record.
- Create **Token C** `tn-mcps-write` with only the edit groups for the approved tools,
  IP filtered, TTL ≤ 30 days; place it on the VM. Approve each write tool going live.

### §8 Phase 10: GitHub App

- Create a GitHub App with minimal per-tool permissions (e.g. Contents: read, Pull
  requests: read/write, Actions: read, Issues: write), install it on selected
  repositories only, and place the private key on the VM.

### §9 Phase 11: Oracle Cloud

- Create an IAM user/group with a policy limited to the listed read and start/stop
  actions, generate an API signing key on the VM (the private key never leaves it), and
  upload the public key in the OCI console.

### §10 Phase 12: Firebase

- Create a service account with minimal roles on specific projects, and place the key
  on the VM (or approve keyless auth if available).

### §11 Phase 14: Jarvis

- Create an Access **service token** for Jarvis (with a set duration), add a Service Auth
  policy for it on the TN-MCPs Access app, store the secret in Jarvis's own secret store
  (Q9), and give Claude the **Client ID only**.

### Things Claude will never ask you for

Passwords, the Cloudflare Global API Key, tokens or secrets pasted into chat, SSH
private keys, or 2FA codes.
