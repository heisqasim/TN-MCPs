# Security

This model is binding for every TN-MCPs process. Boundary IDs B1–B13 refer to
[MASTER_PLAN.md](MASTER_PLAN.md) §A.3. The repository is public; assume every
committed byte is read by an attacker.

## 1. Absolute rules

1. Never commit or print secrets: provider/API credentials, OAuth/service-token
   secrets, private keys, tunnel credentials, cookies, session dumps, or production
   environment files.
2. Never use the Cloudflare Global API Key or its legacy email/key scheme. Use scoped
   tokens only. The repository guard checks this rule, documentation included.
3. Never place a credential in `.mcp.json`; prefer OAuth and otherwise use environment
   expansion only.
4. Never forward inbound `Authorization` or `Cookie` data to a backend/provider (B5).
5. Both the gateway and destination MCP must validate the Access assertion against the
   expected per-provider AUD. A token for one provider must not reach another.
6. Never execute R2 without its current policy gate. Never execute R3 without
   `admin:destructive` and a single-use owner approval; R3 is hard-disabled in
   production until the approvals app exists.
7. An AI agent must never approve or help approve a request. Only the owner in the
   separate MFA-backed approvals app approves production actions.
8. Never register the A1 VM as a self-hosted runner for this public repository.
9. Never open an inbound A1 port for TN-MCPs; ingress is the dedicated Tunnel only.
10. Never expose unrestricted shell. Oracle operations are allowlisted/bounded tools
    and fixed deploy scripts.

## 2. Threat model

| Asset | Threat | Primary control |
| --- | --- | --- |
| Provider credentials | Repo/log/process/tool theft | Per-process `*_FILE` secrets; root-owned modes; redaction; narrow credentials |
| Provider isolation | One server steals another provider token | Separate Unix users and `/etc/tn-mcps/<process>` directories; gateway has no provider credential |
| DNS/zones/tunnels | Unauthorized or accidental mutation | R0–R3, GET-only read client, domain registry, approvals, preconditions, audit |
| Public endpoints | Unauthenticated or wrong-audience access | Path-scoped Access app + gateway verification + backend re-verification |
| Gateway | DNS rebinding, oversized request, abuse | Host/Origin checks, 1 MiB limit, request IDs, per-principal rate limit, loopback bind |
| Development auth | Tunnel accidentally exposes static token auth | B7 runtime refusal plus production preflight |
| Approvals | Agent self-approval or store forgery | Separate Access AUD/MFA; gateway sole writer; Unix peer-UID checks; CLI cannot approve in production |
| Audit | Post-compromise tampering | One HMAC hash chain per process; off-box shipping within 15 minutes |
| CI/supply chain | Malicious PR/action/dependency | GitHub-hosted runners; read-only permissions; pinned actions; frozen lockfile; blocked lifecycle scripts |
| Deploy | Untested/non-main bytes | Public CI proof, ancestry/tree identity, on-host full gate, atomic switch, health check, rollback |
| A1 neighbors | Damage to existing Telos services | Dedicated users/units/tunnel; script unit allowlist `tn-mcp-*`; no inbound rule |
| Prompt injection | Provider data tells a model to mutate | Model cannot approve; R3 exact-args/state approval; policy is server-side |
| **Residual B13** | Agent as passwordless-sudo `ubuntu` reads secrets or edits stores | Outside TN-MCPs. Owner must use a non-sudo agent user or remove passwordless sudo before write credentials; strongly recommended before read credentials |

## 3. Process and credential isolation

Systemd 245 predates `LoadCredential=`. Each service receives only secret file paths.
Every process directory is `root:<service-user> 0750`; files are `root:<service-user>
0640` or stricter. Startup and preflight require a regular file with the expected owner,
group, and mode and reject world-readable files.

| Process | Config | Secrets it may hold |
| --- | --- | --- |
| gateway (`tnmcp-gateway`) | `/etc/tn-mcps/gateway/gateway.env` | approvals/audit integrity material and audit-shipping write credential; no provider token |
| Cloudflare (`tnmcp-cloudflare`) | `/etc/tn-mcps/cloudflare/cloudflare.env` | Cloudflare Tokens A/B and, only after MP 8 + Q11, Token C; its audit key |
| GitHub (`tnmcp-github`) | `/etc/tn-mcps/github/github.env` | GitHub App key/ID; its audit key |
| Oracle (`tnmcp-oracle`) | `/etc/tn-mcps/oracle/oracle.env` | OCI signing material; its audit key |
| Telos (`tnmcp-telos`) | `/etc/tn-mcps/telos/telos.env` | approved service credentials; its audit key |
| Tunnel (`tnmcp-tunnel`) | `/etc/tn-mcps/tunnel/tunnel.env` | `/etc/tn-mcps/tunnel/tunnel.token` |

Access OAuth tokens remain in clients. Each machine identity stores its own Access
service-token secret; servers store only allowlisted Client IDs. Restore credentials
remain off the VM. CI has no deployment secret. Pre-existing credentials belonging to
other VM services are out of scope and are never read, copied, or reused.

Credential inventory:

| Class | Purpose | Location/lifecycle | Phase |
| --- | --- | --- | --- |
| Access human | Client authentication | client only; lifetime from S9 | 4 |
| Approval session | Owner approval | browser only; MFA; session ≤ 10 min | 8 |
| Access machine | JARVIS/automation | consuming client's store; one identity per client | 4/14 |
| Token A | curated Cloudflare reads, IP-filtered | Cloudflare process; TTL ≤ 90 days | 5 |
| Token B | upstream Cloudflare adapter, no IP filter | Cloudflare process; TTL ≤ 30 days | 5 |
| Token C | scoped Cloudflare writes | Cloudflare process; TTL ≤ 30 days; only after MP 8 + Q11 | 9 |
| Tunnel token | dedicated connector | tunnel directory, 0640 | 6 |
| Audit HMAC | per-process chain | that process's directory; rotate with key IDs; retain old verification keys | 3 |
| Audit shipping | object-write-only one-bucket token | gateway directory; TTL ≤ 90 days | 8 |
| Restore | read-only audit bucket access | owner machine only | 8 |

## 4. Enforcement summary

| Rule | Mechanism |
| --- | --- |
| No unwrapped MCP tools | B1 SDK import boundary + B2 sole registration site + per-server registry tests |
| R0 cannot mutate | B3 GET-only client type + read-only Token A |
| Generic upstream boundary | B10 allows only upstream `search`/`execute`; `cf_api_execute` has exact-code R3 approval |
| R3 approval | B4 invariant + production hard-disable until B12 app |
| No passthrough | Gateway strips `Authorization`/`Cookie`; forwards only Access assertion; test |
| Loopback only | Typed central port/bind config + tests + `ss` preflight for every process |
| Dev auth not exposed | B7 configuration refusal + production preflight |
| Approvals store | Gateway single writer; `SO_PEERCRED` UID allowlist on Unix socket |
| CI least privilege | read-only GitHub-hosted workflow with no secrets |

## 5. Risk, scopes, and domain policy

| Risk | Definition | Gate | Examples |
| --- | --- | --- | --- |
| R0 | read-only | scope + audit | list/inspect tools, `cf_api_search` |
| R1 | reversible low-risk write | scope + audit | single DNS upsert in an eligible labs/dev zone |
| R2 | production write | stronger scope + production-target validation + approval default ON | production DNS upsert, deploy, tunnel route update |
| R3 | destructive/account-wide | `admin:destructive` + single-use out-of-band owner approval every time | zone or nameserver changes; deleting R2/Worker/Pages/tunnel; bulk DNS; account-wide security; credential issue/revoke; `cf_api_execute` |

The owner may relax R2 approval only per target as recorded policy data. R3 cannot be
relaxed and is hard-disabled in production until Phase 8. A single DNS record deletion
is R1/R2 by target; deleting more than one is R3. When uncertain, classify higher.

Allowed scope vocabulary: `tn:read`, `cloudflare:read`, `cloudflare:dns:write`,
`cloudflare:deploy:write`, `cloudflare:tunnel:write`, `github:read`, `github:write`,
`oracle:read`, `oracle:service:restart`, `telos:deploy`, `admin:destructive`, and
`cloudflare:admin` only for `cf_api_execute`. Roles map to scope sets; unlisted
identities are denied. Owner Claude Code defaults to `tn:read` + `cloudflare:read`;
JARVIS defaults to read scopes for TN, Cloudflare, GitHub, and Oracle. No normal client
gets `admin:destructive`.

`packages/policy` stores the proposed domain registry from CLOUDFLARE §4. Production
includes `.io`, `.co`, `.services`, `.app`, and live-service `.cloud` routes; `.space`
is non-production/R1-eligible. Q4 requires owner confirmation. Existing stable URLs,
OAuth callbacks, Android App Links, QR codes, Firebase hosting, and public endpoints
are migrated only deliberately.

## 6. Approval and audit invariants

The gateway owns the approval store. MCP processes request/check/consume through
`/run/tn-mcps/gateway.sock`; peer UID identifies the calling server. Approvals bind
principal, tool, RFC 8785 canonical argument hash, precondition hash, policy version,
gateway release, and expiry (default 15 minutes). They are single-use. The approver
sees full non-secret semantic arguments and state diff. State is rechecked immediately
before execution. A crash after claiming execution produces `unknown_outcome` and is
never retried automatically.

Each process writes its own chain under `/var/lib/tn-mcps/audit/<process>/`. Records
include correlation/request ID, principal, client, tool, risk, redacted arguments,
decision, approval ID where relevant, outcome, duration, and upstream request IDs.
Chains use RFC 8785 serialization, sequence numbers, prior hash, HMAC, and key ID,
continue across daily files, fsync intent before execution, preserve partial tails, and
append recovery records. If audit intent fails, execution is refused.

## 7. Logging and failure defaults

- Structured JSON logs go to stderr/journald and pass through `redact()`. Never log
  raw requests, credentials, prompts, private bodies, or full provider responses.
- Missing/unreadable/wrong-mode secret: refuse startup and name only the variable.
- JWKS failure: cached keys may be used only within 24 hours; unknown key IDs fail.
- Audit failure or approval-store busy beyond five seconds: refuse gated execution;
  R0 calls remain available for store contention only.
- Provider timeout defaults to 10 seconds; writes are never automatically retried.
- Unsynchronized clock blocks deploy; rate limits are per principal and reset on
  restart, an accepted limitation because R3 remains approval-gated.

## 8. Supply chain and repository settings

- Secret scanning and push protection; Dependabot alerts/security updates.
- Main ruleset requires PR and `check`, blocks force pushes and deletion.
- Actions use read-only permissions, pinned SHAs, frozen lockfile, no deployment
  secrets, no untrusted self-hosted runner, and approval for external fork workflows.
- Dependency lifecycle scripts stay blocked unless explicitly reviewed and recorded.
- Pull-based production deploys require exact-SHA successful push CI, ancestry/tree
  checks, on-host gate, schema compatibility, atomic switch, health, and rollback.

## 9. Incident response

1. Suspected credential leak: revoke/rotate at the provider first, then investigate;
   history cleanup is secondary.
2. Suspected TN-MCPs compromise: stop only the dedicated `tn-mcp-tunnel.service` and
   affected `tn-mcp-*.service` units. Copy `/var/lib/tn-mcps/audit` aside and compare
   with off-box records. Do not touch existing Telos units.
3. Gateway health succeeds locally but edge fails: check Cloudflare status and the
   dedicated tunnel connector; do not restart healthy MCP processes blindly.
4. Unexpected mutation: correlate process audit records by request ID and compare with
   provider audit logs.
5. `unknown_outcome`: never retry. Read actual state, audit the finding, and request a
   new approval only if still needed.

## Sources

- MCP security/authorization: https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices ·
  https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- GitHub secure Actions: https://docs.github.com/en/actions/reference/security/secure-use
- Cloudflare API tokens: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/ ·
  https://developers.cloudflare.com/fundamentals/api/reference/permissions/
- Cloudflare Access JWT/service tokens: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/ ·
  https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
