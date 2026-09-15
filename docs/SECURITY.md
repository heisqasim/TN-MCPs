# Security

The security model for TN-MCPs. This document is binding for every contributor,
human or agent. If code and this document disagree, the code is wrong until the
document is deliberately changed in a reviewed commit. Boundary IDs (B1–B13) refer to
[MASTER_PLAN.md](MASTER_PLAN.md) §A.3, which also states how each is enforced.

The repository is **public**. Assume every committed byte is read by an attacker.

---

## 1. Absolute rules

1. Never commit secrets: API tokens, OAuth client secrets, service-token secrets,
   SSH or TLS private keys, tunnel tokens, `.env` files, cookies, session dumps.
2. Never use the **Cloudflare Global API Key** or the legacy email-plus-key header
   scheme that goes with it. Scoped API tokens only. The secret guard rejects that
   legacy key header name anywhere in the tree (rule `cloudflare-global-key-usage`),
   documentation included.
3. Never print a secret value in logs, tool results, error messages, audit records,
   commit messages, PR text, or chat. Report *that* a secret exists and *where*, never
   its value.
4. Never place a credential in `.mcp.json`. Only `${VAR}` expansion is allowed, and
   OAuth is preferred.
5. Never forward an inbound client token to an upstream provider (B5).
6. Never execute a `write` or `destructive` operation in production without an
   approval from the approvals app when policy requires one. Destructive always
   requires one (B4, B12).
7. An AI agent must never try to approve, or help approve, an approval request. Only
   the owner, in the approvals app, approves.
8. Never register the A1 VM as a GitHub self-hosted runner for this public repository.
9. Never open an inbound port on the A1 VM for TN-MCPs. Ingress is Cloudflare Tunnel only.

## 2. Threat model (summary)

| Asset | Threat | Primary control |
| --- | --- | --- |
| Provider credentials | Theft from repo, logs, process env, or tool output | Never in repo; permissioned files read by path (`*_FILE`); secret-file rule enforced at startup; redaction; scoped, short-lived tokens |
| Telos Nexus DNS / zones / tunnels | Unauthorized or accidental mutation by an agent | Risk classes, separate read/write tokens, GET-only read client, out-of-band approvals, precondition re-check, audit |
| Gateway endpoint | Unauthenticated access, token reuse from another service | Access at the edge + origin verification of `Cf-Access-Jwt-Assertion` (`aud`, `iss`, alg, claim-shape contract) |
| Gateway endpoint | DNS rebinding, local-process abuse, dev auth exposed via tunnel | Loopback bind; Host/Origin validation; JWT required even on loopback; `dev` auth refused whenever a public URL is configured (B7) |
| Approvals | Self-approval by the requesting model/agent | Separate Access app + audience separation + MFA (B12); CLI can't approve in production |
| Audit trail | Tampering after compromise | Hash-chained, HMAC'd (`keyId`) records; off-box shipping with ≤ 15 min lag (Phase 8) |
| CI / supply chain | Malicious PR code, compromised action or dependency | GitHub-hosted runners only; `permissions: contents: read`; SHA-pinned actions; frozen lockfile; dependency build scripts blocked; Dependabot |
| Deploy | Deploying code that CI didn't test, or code not on `main` | DEPLOYMENT_A1 §4 trust chain: public-API check of a push-on-`main` CI run for the exact SHA, ancestry check, tree check, full gate on the VM |
| A1 VM neighbors | Collateral damage to live Jarvis / Telos services | Own users, systemd sandboxing, memory limit, separate tunnel, unit-name allowlist in scripts (B11) |
| The model itself | Prompt injection via provider data (e.g. a TXT record saying "delete all zones") | The model can't approve (B12); destructive ops need the owner's MFA-backed decision bound to exact arguments and state |
| **Residual (B13)** | An agent running as `ubuntu` (passwordless sudo) on the VM reads provider tokens or edits stores directly | **Outside TN-MCPs' control.** Owner decision Q11: run agents as a non-sudo user or remove passwordless sudo. Required before write credentials exist; strongly recommended before Phase 5 read tokens |

## 3. Credential classes and secret inventory

Locations and lifecycle only. **No values.** The VM's systemd (245) predates
`LoadCredential=` (systemd 247), so services receive only each file's **path** through a
`*_FILE` variable and read it at startup. Values never enter the process environment.

**Secret-file rule** (enforced by the gateway at startup and by `preflight.sh`): regular
file, owned by root, group = the service's group, mode `0640` or stricter, never
world-readable.

| Class | Credential | Purpose | Location (planned) | Lifetime / rotation | Phase |
| --- | --- | --- | --- | --- | --- |
| Human OAuth | Access Managed OAuth token (opaque `oauth:…`) | Humans' MCP clients → gateway | Held by the client only | Lifetime per the S9 spike result; session per Access policy | 4 |
| Human approval | Access session on the approvals app | Owner → approvals app | Owner's browser only | Session ≤ 10 min, MFA | 8 |
| Machine | Access service token (Client ID + Secret, `cfast_…`) | Jarvis / automation → gateway | The consuming client's own secret store. The gateway stores **only the Client ID** | Set a duration; rotate with grace period; one token per client | 4, 14 |
| Provider (read) | Token A: Cloudflare read-only, IP-filtered, account-owned (`cfat_`) preferred | Curated read tools | `/etc/tn-mcps/gateway/cloudflare-read.token` | TTL ≤ 90 days | 5 |
| Provider (read, upstream) | Token B: read-only, no IP filter | Upstream `search` only | `/etc/tn-mcps/gateway/cloudflare-read-upstream.token` | TTL ≤ 30 days | 5 |
| Provider (write) | Token C: only the edit groups for approved tools | Controlled writes | `/etc/tn-mcps/gateway/cloudflare-write.token` | TTL ≤ 30 days; IP filtered; created only after the Phase 8 exit + Q11 | 9 |
| Infrastructure | Tunnel token for the dedicated `tn-mcps` tunnel | `cloudflared` ↔ Cloudflare | `/etc/tn-mcps/tunnel/tunnel.token` (`root:tnmcp-tunnel 0640`) | Re-issue on compromise | 6 |
| Integrity | Audit HMAC keys (32 random bytes each, with `keyId`) | Audit chain | `/etc/tn-mcps/gateway/audit-hmac-<keyId>.key` | Rotate yearly; old keys kept for verification | 3 |
| Backup (write) | R2 token: object write, one bucket | Audit shipping | `/etc/tn-mcps/gateway/r2-audit-write.token` | TTL ≤ 90 days | 8 |
| Backup (read) | R2 token: object read, same bucket | Restores and drills | **Off the VM**, on the owner's machine | Used only for drills/incidents | 8 |
| CI/CD | `GITHUB_TOKEN` (ephemeral, `contents: read`) | CI checks | GitHub-managed | Per job | 1 |
| CI/CD | *(none)* | Deployment is pull-based. CI holds no VM credentials, and `deploy.sh` uses only public, unauthenticated GitHub API reads | n/a | n/a | 6 |
| Provider (later) | GitHub App private key + App ID | GitHub provider | `/etc/tn-mcps/gateway/github-app.pem` | Per GitHub guidance; installation tokens 1 h | 10 |
| Provider (later) | OCI API signing key | Oracle provider | `/etc/tn-mcps/gateway/oci/` | ≤ 90 days | 11 |
| Provider (later) | Firebase service-account key (or keyless) | Firebase provider | `/etc/tn-mcps/gateway/firebase-sa.json` | ≤ 90 days | 12 |

Pre-existing credentials on the VM that belong to other systems (the existing Telos
Nexus tunnel token, the `gh` CLI login, agent CLI logins) are **out of scope**. TN-MCPs
never reads, copies, or reuses them.

`.env.example` lists variable **names** only. Local `.env` files are gitignored and are
for development with throwaway values.

## 4. Enforcement summary

MASTER_PLAN §A.3 is authoritative. The security-relevant highlights:

| Rule | Mechanism |
| --- | --- |
| Secrets not committed | GitHub secret scanning + push protection; `scripts/guard-secrets.mjs` in `pnpm run check` and CI |
| No unwrapped tools | B1 dependency graph + B2 single call site (`check-boundaries.mjs`) + registry test |
| Read tools can't write | B3: GET-only client type + read-only token |
| Upstream MCP can't mutate | B10: only `search` is proxied, via a constant allowlist with a test |
| Destructive needs approval | B4 registry invariant + policy engine; B12 approvals-app audience separation |
| No token passthrough | B5 header stripping; `ctx` has no raw request; test |
| Loopback only | B6 config schema + test + `ss` check in preflight |
| Dev auth never exposed | B7 `TN_AUTH_MODE` rules + preflight refuses `dev` |
| CI least privilege | `permissions: contents: read`; GitHub-hosted runner; no secrets referenced |

## 5. Risk classes and approval policy

| Class | Definition | Approval | Examples (Cloudflare) |
| --- | --- | --- | --- |
| `read` | No state change anywhere | Never | `cloudflare_list_zones`, `cloudflare_get_dns_records`, `cloudflare_get_tunnels`, `cloudflare_api_search` |
| `write` | Reversible change to a single named resource | Per policy: always for `production` resources; configurable for staging | `cloudflare_dns_upsert` (one record), `cloudflare_pages_deploy`, `cloudflare_worker_deploy`, `cloudflare_tunnel_route_update` |
| `destructive` | Irreversible, bulk, or ownership/availability-affecting | **Always**: single-use, bound to exact arguments and current state, 15 min expiry. **Cannot be relaxed by config** | delete zone · change nameservers · delete R2 bucket · delete Workers script/project · destroy tunnel · delete more than one DNS record · purge everything · delete an Access application · any action on the A1 host itself |

Rules:
- When classification is in doubt, a tool is `destructive`. Bulk operations are
  `destructive`.
- The approver must be a human principal with the `admin` role, authenticated to the
  **approvals app**, and must not be the requesting principal. Service principals can
  never approve.
- If the resource's state changed between approval and execution, the call is refused
  and a new approval is needed.
- The policy table lives in code (`packages/policy`) and is reviewed like code. There is
  no runtime "disable approvals" switch.

## 6. Logging and redaction

- Structured JSON logs to stderr → journald. `@tn-mcps/shared` `redact()` runs on every
  logged or audited object. It masks secret-named keys, `Bearer`/`Basic` values,
  Cloudflare/GitHub/Anthropic/OpenAI token shapes, JWTs, and PEM blocks, and it
  normalizes Error objects without stacks.
- Never log full provider responses. Log IDs, counts, and upstream request IDs.
- Config errors name the **variable**, never the received value (`ConfigError`).
- The approvals app shows full semantic arguments to the owner. Tools never accept
  secrets as arguments, so nothing secret is displayed.

## 7. GitHub repository settings (owner applies; MASTER_PLAN Owner Actions §1)

- Secret scanning on (automatic for public repos); push protection on.
- Dependabot alerts and security updates on.
- Actions → General: workflow permissions **read**; Actions may not create/approve PRs;
  fork PR workflows **require approval for all external contributors**; **require
  actions pinned to full-length commit SHAs**.
- Ruleset on `main`: require a pull request, require status check `check`, block force
  pushes, block deletion.
- No self-hosted runners. No deployment secrets in GitHub.

## 8. Supply chain

- `pnpm-lock.yaml` committed; CI uses `--frozen-lockfile`; the VM installs with
  `--frozen-lockfile` too.
- pnpm's default of not running dependency lifecycle scripts is kept. Any exception is
  listed explicitly in `pnpm-workspace.yaml` with a reason.
- Actions are pinned to full commit SHAs, with the version in a comment. Dependabot keeps
  them current. (Dependabot doesn't raise *alerts* for SHA-pinned actions, but version
  updates still arrive.)
- Prefer official SDKs (`@modelcontextprotocol/*`, `cloudflare`) over community wrappers.

## 9. Incident response

1. **Suspected credential leak:** revoke or rotate the credential at the provider
   **first** (Cloudflare dashboard → API Tokens → Roll/Delete; Access → Service Tokens →
   Rotate), then clean up. History rewriting is secondary: GitHub's guidance is to
   rotate immediately.
2. **Suspected gateway compromise:** `sudo systemctl stop tn-mcps-tunnel tn-mcps-gateway`.
   The endpoint goes dark and no other Telos service is affected. Copy
   `/var/lib/tn-mcps/audit` aside before investigating, then compare it with the off-box
   copy.
3. **Endpoint returns errors but the gateway is healthy** (`curl 127.0.0.1:8787/healthz`
   OK): suspect Access or the tunnel, not the gateway. Check Cloudflare status and the
   tunnel's connector status in the dashboard, and `journalctl -u tn-mcps-tunnel`.
   **Don't restart the gateway** for an edge problem.
4. **Unexpected mutation:** audit records carry the correlation ID and upstream request
   IDs. Cloudflare's own audit logs confirm what changed.
5. **`unknown_outcome` approval** (crash mid-execution): never re-run. Read the actual
   resource state, record the finding in the audit log via the CLI, and request a fresh
   approval if still needed.

## Sources

- MCP security best practices: https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices
- MCP authorization (token passthrough, audience validation): https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- GitHub Actions secure use: https://docs.github.com/en/actions/reference/security/secure-use
- GitHub Actions repository settings: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository
- GitHub rulesets: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
- GitHub secret scanning / push protection: https://docs.github.com/en/code-security/secret-scanning/about-secret-scanning · https://docs.github.com/en/code-security/concepts/secret-security/push-protection
- Cloudflare API tokens / permissions / account-owned tokens / Global API key:
  https://developers.cloudflare.com/fundamentals/api/get-started/create-token/ ·
  https://developers.cloudflare.com/fundamentals/api/reference/permissions/ ·
  https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/ ·
  https://developers.cloudflare.com/fundamentals/api/get-started/keys/
- Cloudflare Access JWT validation / application token / service tokens:
  https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/ ·
  https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/ ·
  https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
