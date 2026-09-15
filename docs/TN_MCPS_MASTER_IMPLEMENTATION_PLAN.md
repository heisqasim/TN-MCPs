# Telos Nexus MCPs — Master Implementation Plan

**Repository:** `heisqasim/TN-MCPs`  
**Owner:** Telos Nexus / Qasim Hamad  
**Status:** Initial architecture and implementation plan  
**Primary execution environment:** Oracle Cloud A1 VM  
**Primary remote endpoint target:** `https://mcp.telosnexus.cloud`  
**Initial agent/client:** Claude Code  
**Long-term clients:** JARVIS, Codex/OpenAI API, Claude API/Claude Code, other approved MCP-capable clients

---

## 1. Purpose

`TN-MCPs` is intentionally plural.

This repository is **not** intended to contain one Cloudflare-specific MCP server. It is the home for multiple Telos Nexus Model Context Protocol integrations, gateways, policy layers, and adapters.

The project should become the reusable **tool and infrastructure control plane** for Telos Nexus. AI models and agents are clients of this control plane; they do not own it.

The long-term architectural rule is:

> **Jarvis / Telos Nexus owns the tools, permissions, audit trail, and policies. Models are replaceable clients.**

This avoids coupling Telos Nexus to Claude, OpenAI, Gemini, DeepSeek, or any single vendor.

---

## 2. Research basis and current platform facts

This plan is based on current official documentation reviewed in September 2026.

### Cloudflare MCP

Cloudflare maintains managed remote MCP servers and supports OAuth-capable clients such as Claude. For new connections, Cloudflare documents **Streamable HTTP** and the `/mcp` endpoint. Its Cloudflare API MCP server exposes the Cloudflare API, including DNS, Workers, R2, Zero Trust, and other services.

Cloudflare's API MCP uses a Code Mode approach rather than exposing thousands of separate tool definitions. This allows an agent to reach the wider Cloudflare API while keeping tool-context overhead comparatively small.

Official references:

- https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/
- https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/
- https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/
- https://developers.cloudflare.com/agents/model-context-protocol/guides/securing-mcp-server/
- https://developers.cloudflare.com/agents/model-context-protocol/codemode/

### MCP transport and authorization

The modern MCP remote transport is **Streamable HTTP**. MCP authorization is based on OAuth-style authorization and protected-resource metadata. Administrative MCP servers must not be deployed as unauthenticated public endpoints.

Official references:

- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/authorization
- https://modelcontextprotocol.io/docs/draft/tutorials/security/security_best_practices

### Claude Code

Claude Code supports remote HTTP MCP servers and is an appropriate first client for TN-MCPs. The project configuration should ultimately allow a developer to add the Telos Nexus MCP endpoint at project scope without embedding secrets in the repository.

Official reference:

- https://code.claude.com/docs/en/mcp

### Cloudflare Tunnel

`cloudflared` can expose a service through an outbound connection to Cloudflare. A production TN-MCPs deployment should therefore avoid opening a public inbound TCP port directly to the Oracle A1 origin.

Official references:

- https://developers.cloudflare.com/tunnel/
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/

### GitHub deployment/security

GitHub supports repository/environment secrets and self-hosted runners. However, GitHub specifically warns about the security implications of self-hosted runners, especially with public repositories and untrusted pull requests.

Official references:

- https://docs.github.com/en/actions/concepts/runners/self-hosted-runners
- https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets
- https://docs.github.com/en/actions/hosting-your-own-runners/adding-self-hosted-runners

Because `TN-MCPs` is currently public, **do not attach a privileged production self-hosted A1 runner to workflows that can execute arbitrary untrusted PR code**.

---

## 3. Desired end state

The target architecture is:

```text
Claude Code ────────┐
Claude API ─────────┤
OpenAI/Codex API ───┤
JARVIS ─────────────┼──── HTTPS / MCP ────> TN MCP Control Plane
Future clients ─────┘                        mcp.telosnexus.cloud
                                                │
                 ┌──────────────────────────────┼──────────────────────────────┐
                 │                              │                              │
          Cloudflare MCP/API             GitHub API/MCP                 Oracle/local tools
                 │                              │                              │
       DNS / Workers / R2 /             repos / PRs / issues /          services / logs /
       Access / Tunnels / etc.           releases / deploy state         processes / health
                 │                              │                              │
                 └──────────────────────────────┼──────────────────────────────┘
                                                │
                                       Telos project adapters
                                                │
                               JARVIS / SADS / web / apps / future systems
```

The A1 VM hosts the Telos MCP services, policy layer, audit system, and optional upstream adapters.

Cloudflare provides the externally reachable HTTPS edge through Tunnel and the authorization/security layer.

---

## 4. Important architectural decision: multi-MCP repository, not one giant server

The repository should support **multiple MCP servers with shared libraries**, not one monolithic MCP that has every permission.

Recommended structure:

```text
TN-MCPs/
├── README.md
├── CLAUDE.md
├── docs/
│   ├── TN_MCPS_MASTER_IMPLEMENTATION_PLAN.md
│   ├── architecture.md
│   ├── security.md
│   ├── deployment-a1.md
│   └── operations.md
│
├── mcps/
│   ├── cloudflare/
│   │   ├── src/
│   │   ├── tests/
│   │   └── README.md
│   │
│   ├── github/
│   │   ├── src/
│   │   ├── tests/
│   │   └── README.md
│   │
│   ├── oracle/
│   │   ├── src/
│   │   ├── tests/
│   │   └── README.md
│   │
│   └── telos-control/
│       ├── src/
│       ├── tests/
│       └── README.md
│
├── packages/
│   ├── auth/
│   ├── policy/
│   ├── audit/
│   ├── config/
│   ├── observability/
│   └── mcp-common/
│
├── gateway/
│   ├── src/
│   └── tests/
│
├── deploy/
│   ├── systemd/
│   ├── cloudflared/
│   ├── scripts/
│   └── env/
│
├── scripts/
├── tests/
└── .github/
    └── workflows/
```

### Why separate servers?

Isolation.

A Claude session that only needs GitHub should not automatically inherit Cloudflare DNS write permission. A monitoring client should not automatically receive deployment/delete capabilities. Separate MCPs allow different authorization scopes and blast radii.

### Why a gateway too?

The gateway gives clients a stable Telos Nexus entry point while the backend MCPs can evolve independently.

Recommended public path model:

```text
https://mcp.telosnexus.cloud/cloudflare/mcp
https://mcp.telosnexus.cloud/github/mcp
https://mcp.telosnexus.cloud/oracle/mcp
https://mcp.telosnexus.cloud/telos/mcp
```

A future registry/index endpoint may advertise the available services, but **it must not expose credentials or sensitive infrastructure metadata**.

---

## 5. First implementation target: Cloudflare MCP

Cloudflare should be the first completed MCP because it becomes part of the control plane that exposes and protects the rest of TN-MCPs.

### Phase CF-0 — Read-only discovery

Before allowing mutation, implement/test read-only operations:

- identify Cloudflare account(s)
- list zones
- list DNS records
- list Workers/Pages projects
- list tunnels
- list R2 buckets
- inspect Access applications/policies
- inspect relevant analytics/status where appropriate

No write operation should be enabled until authentication, audit logging, and policy enforcement are working.

### Phase CF-1 — Safe writes

Enable low/medium-risk operations through explicit policy:

- create/update DNS records
- create/update development Worker configuration
- deploy approved Pages/Workers artifacts
- manage approved Tunnel routes
- update approved Access configuration

### Phase CF-2 — High-risk operations

High-risk tools must require explicit approval or remain disabled by default:

- delete zone
- change authoritative nameservers
- delete production Worker/Pages project
- delete R2 bucket/data
- remove Tunnel protecting production services
- modify account-wide security controls
- issue/revoke broad credentials
- destructive bulk DNS edits

The MCP must distinguish **read**, **write**, and **destructive/admin** operations.

---

## 6. Cloudflare integration strategy

There are two valid integration layers. TN-MCPs should be designed so either can be used without redesigning the repository.

### Option A — Use Cloudflare's official API MCP upstream

TN-MCPs acts as a policy/audit gateway and connects to Cloudflare's managed MCP.

Advantages:

- Cloudflare maintains API coverage
- broad service support
- fast access to new endpoints
- OAuth support
- less custom Cloudflare API wrapper code

The Telos layer still adds:

- Telos-specific allowlists
- approval rules
- project/domain boundaries
- audit records
- consistent naming
- stable agent-facing tool semantics

### Option B — Direct Cloudflare API from TN-MCPs

Use Cloudflare's API directly with a narrowly scoped token or OAuth credentials.

Advantages:

- deterministic typed wrappers for critical workflows
- easier enforcement of Telos-specific invariants
- no MCP-to-MCP translation layer for core actions

Disadvantage:

- Telos Nexus must maintain more provider integration code.

### Recommended hybrid

Use the **official Cloudflare MCP/API coverage for discovery and broad capability**, while implementing **explicit Telos-owned wrappers for high-value production workflows**.

For example, the agent should preferably call:

```text
te_dns_set_record(zone="telosnexus.io", ...)
te_deploy_company_site(...)
te_route_tunnel(service="jarvis", ...)
```

rather than being encouraged to improvise a sequence of unrestricted account-level calls every time.

The Cloudflare API/MCP remains available behind the policy layer for operations that do not yet have a Telos workflow wrapper.

---

## 7. Telos Nexus domain policy to encode

The MCP must understand the current Telos Nexus domain architecture instead of treating all domains as interchangeable.

Current architecture:

```text
telosnexus.io       = canonical Telos Nexus company/master identity
telosnexus.co       = alias / redirect target to .io
telosnexus.services = Services vertical
telosnexus.app      = product catalogue / app family
telosnexus.cloud    = cloud/runtime/infrastructure namespace
telosnexus.space    = labs/research/experiments/independent projects
```

Preferred MCP/control-plane hostname:

```text
mcp.telosnexus.cloud
```

Do not automatically migrate old stable production URLs merely because `.cloud` exists. Runtime migrations involving OAuth callbacks, Android App Links, QR codes, Firebase hosting, or existing public endpoints must be deliberate migrations.

---

## 8. Oracle A1 deployment model

### Host assumptions

Target:

- Oracle Cloud Always Free / A1-compatible VM
- Linux
- systemd available
- Docker optional, not mandatory
- outbound internet access
- `cloudflared` installed

### Origin binding

MCP processes should bind only to loopback unless there is a strong internal-network reason not to:

```text
127.0.0.1:8701   cloudflare MCP
127.0.0.1:8702   github MCP
127.0.0.1:8703   oracle MCP
127.0.0.1:8704   telos-control MCP
127.0.0.1:8790   gateway
```

Exact ports may change, but they must be centrally configured.

### Public exposure

Do **not** expose these ports directly in the Oracle security list/firewall.

Use:

```text
Internet
   |
Cloudflare edge
   |
Cloudflare Access / OAuth
   |
Cloudflare Tunnel
   |
A1 localhost:8790
   |
TN MCP gateway
```

`cloudflared` creates the outbound tunnel. Production ingress should therefore not require an open public MCP port.

### Process supervision

Each production process should have a systemd unit or equivalent supervised service.

Requirements:

- restart on failure
- bounded restart delay
- dedicated Unix user if practical
- working directory pinned
- environment file outside Git
- logs available via journald
- health endpoint where protocol/security permit

Example service naming:

```text
tn-mcp-gateway.service
tn-mcp-cloudflare.service
tn-mcp-github.service
tn-mcp-oracle.service
tn-mcp-telos.service
cloudflared.service
```

---

## 9. Authentication and authorization model

Security is a first-class deliverable, not a final cleanup phase.

### External client authentication

Preferred production design:

1. Client connects to `mcp.telosnexus.cloud/.../mcp`.
2. Cloudflare edge terminates TLS.
3. Cloudflare Access/OAuth validates the identity.
4. TN-MCPs validates expected authorization context/token claims.
5. Policy layer maps identity to scopes.
6. Tool invocation is authorized.
7. Invocation and result metadata are audited.

### Scope examples

```text
tn:read
cloudflare:read
cloudflare:dns:write
cloudflare:deploy:write
cloudflare:tunnel:write
github:read
github:write
oracle:read
oracle:service:restart
telos:deploy
admin:destructive
```

Do not use one boolean `is_admin` as the entire authorization model.

### Separate machine identities

Where possible, use separate credentials for:

- interactive Qasim/Claude use
- JARVIS runtime
- CI/deployment automation
- read-only monitoring

This makes revocation and auditing much easier.

---

## 10. Credential rules

### Absolutely forbidden in Git

Never commit:

- Cloudflare API tokens
- Global API key
- Oracle private SSH keys
- GitHub PATs
- OAuth client secrets
- tunnel credentials
- JWT signing secrets
- production `.env`
- service account JSON

Add defensive `.gitignore` patterns early.

### Cloudflare

Do **not** use Cloudflare Global API Key for TN-MCPs.

Prefer:

1. OAuth where the upstream/client flow supports it, or
2. a scoped Cloudflare API Token restricted to the minimum resources/permissions required.

Start read-only and expand scopes only when a tested feature requires it.

### GitHub

For long-lived server automation, prefer an appropriately scoped GitHub App over a broad personal access token when implementation maturity permits.

For early development, a fine-grained token can be used only if:

- repository scope is restricted
- permissions are minimal
- it is stored only on the A1 secret store/environment
- rotation is documented

### Local secret storage

Initial practical deployment:

```text
/etc/tn-mcps/
    gateway.env
    cloudflare.env
    github.env
    oracle.env
```

Permissions should be restricted to the service account/root as appropriate.

Future improvement: use a dedicated secret manager / encrypted secrets workflow.

---

## 11. Audit and approval system

Every sensitive tool call must produce a structured audit event.

Minimum fields:

```json
{
  "timestamp": "...",
  "request_id": "...",
  "actor": "qasim|jarvis|claude-code|ci|...",
  "client": "...",
  "mcp_server": "cloudflare",
  "tool": "dns.update",
  "risk": "write",
  "target": "telosnexus.io",
  "decision": "allowed|denied|approval_required",
  "result": "success|failed",
  "duration_ms": 0
}
```

Do not log plaintext credentials, authorization headers, private keys, or entire sensitive payloads.

### Risk levels

Recommended:

```text
R0 = read-only
R1 = reversible low-risk write
R2 = production write
R3 = destructive/account-wide action
```

Policy:

- R0: normal allowed identities
- R1: allowed with correct scope + audit
- R2: stronger scope and production target validation
- R3: explicit human approval or disabled entirely

The approval mechanism can initially be local/manual. Do not block Phase 1 waiting for an elaborate approval UI, but do not silently treat destructive operations as normal tools.

---

## 12. MCP protocol implementation requirements

The implementation Claude builds should follow the current MCP SDK/spec rather than old SSE-only tutorials.

Requirements:

- support Streamable HTTP for remote MCP
- canonical MCP endpoint ends in `/mcp`
- support initialization/capability negotiation correctly
- validate request content types and protocol expectations
- enforce authentication before sensitive tool execution
- propagate structured MCP errors rather than generic stack traces
- do not expose internal exception details/secrets
- implement graceful shutdown
- implement request IDs/correlation IDs
- add timeouts around upstream Cloudflare/GitHub/network calls
- bound retries; no infinite agent/server retry loops
- use idempotency/safety checks for writes where possible
- remain compatible with Claude Code remote MCP behavior

If the selected SDK has not yet fully caught up with MCP 2026-07-28, Claude should document the exact SDK/version and compatibility behavior rather than inventing protocol behavior manually.

---

## 13. Recommended implementation language

Claude should inspect the current official MCP SDK maturity before committing the stack.

Preferred choices:

### TypeScript / Node.js — recommended initial default

Reasons:

- strong MCP ecosystem support
- Cloudflare examples/ecosystem are heavily TypeScript-oriented
- good schema tooling
- easy HTTP services
- easy shared monorepo packages

Suggested baseline:

- Node.js current supported LTS
- TypeScript strict mode
- official MCP SDK
- schema validation library
- structured logger
- test runner suitable for unit + integration tests

### Python

Acceptable if the official Python MCP SDK provides equivalent support for the required remote transport and authorization model. Do not mix languages across MCPs without a real reason.

### Rule

The first Claude implementation task must verify the latest official SDK recommendations before pinning versions.

---

## 14. Tool design rules

MCP tools should be **clear, narrow, and safe**.

Bad:

```text
run_any_cloudflare_request(method, path, body)
run_shell(command)
```

These bypass the safety model.

Better:

```text
cf_list_zones()
cf_list_dns_records(zone)
cf_upsert_dns_record(zone, name, type, content)
cf_list_tunnels()
cf_get_worker(name)
```

Best for core Telos workflows:

```text
tn_publish_company_site(revision)
tn_attach_domain(surface, hostname)
tn_route_runtime(service, hostname, origin)
tn_check_domain_architecture()
```

Generic provider APIs can exist behind an advanced/admin boundary, but the normal agent path should use semantically meaningful Telos-owned tools.

---

## 15. GitHub MCP/service roadmap

The second provider MCP should be GitHub.

Initial read tools:

- repository metadata
- branches
- commits
- pull requests
- issues
- workflow/run status
- releases

Later controlled writes:

- create branch
- create/update file
- create issue
- open PR
- comment/review
- merge under policy

High-risk actions:

- repository deletion
- secrets management
- collaborator/admin changes
- force push/protected-branch bypass

These should not be normal MCP tools.

For server-side automation, investigate GitHub App authentication so TN-MCPs is not permanently tied to Qasim's personal token.

---

## 16. Oracle/local MCP roadmap

The Oracle MCP is intentionally narrower than a general shell MCP.

Allowed examples:

- health checks
- disk/memory/CPU status
- list approved services
- read approved logs with limits
- restart an allowlisted service
- deploy an approved artifact through a fixed script
- inspect current git revision for approved deployments

Avoid exposing unrestricted shell access to routine AI clients.

Bad:

```text
shell("sudo ...")
```

Preferred:

```text
oracle_restart_service("jarvis")
oracle_tail_service_logs("tn-mcp-gateway", lines=200)
oracle_deploy("tn-mcps", revision="...")
```

Allowlist service names and deployment targets.

---

## 17. Telos-control MCP roadmap

This is the most important long-term server because it turns provider primitives into Telos business/infrastructure workflows.

Examples:

- inspect all Telos domain health
- verify the `.io/.services/.app/.cloud/.space` architecture
- deploy a Telos web surface
- route a service through Cloudflare Tunnel
- check production service health
- return deployment inventory
- validate project/domain ownership
- surface infrastructure drift
- coordinate safe multi-provider operations

This server should call provider packages or provider MCPs while applying Telos policy.

It must **not** become Jarvis itself. It is Jarvis's infrastructure/tool plane.

---

## 18. Claude Code integration

Claude Code is the first development/operator client.

After a remote MCP endpoint is available, configure Claude Code at project/user scope using the official remote HTTP MCP mechanism documented by Anthropic.

Do not commit personal bearer tokens or OAuth access tokens into `.mcp.json` or any tracked file.

Desired operator experience:

```text
Qasim -> Claude Code -> TN MCP -> policy -> Cloudflare/GitHub/Oracle
```

Claude should be able to:

1. discover allowed tools
2. inspect infrastructure
3. propose changes
4. execute allowed changes
5. receive policy denial for unapproved operations
6. leave an audit trail

Project documentation should include exact current Claude CLI commands after the implementation verifies them against the installed Claude Code version.

---

## 19. JARVIS integration

JARVIS is a first-class future client, not a submodule controlled by Claude.

JARVIS should receive its own machine identity/scopes.

Example:

```text
JARVIS default scopes:
- tn:read
- cloudflare:read
- github:read
- oracle:read

Elevation only for a requested workflow:
- cloudflare:dns:write
- telos:deploy
```

Avoid giving JARVIS permanent destructive Cloudflare/GitHub privileges simply because it can technically call the server.

JARVIS can later mediate human approval and higher-level orchestration.

---

## 20. CI/CD strategy

The server must be testable without real production credentials.

### Pull request CI

Safe tests:

- formatting
- linting
- typecheck
- unit tests
- protocol contract tests
- mocked provider tests
- security/static checks

No production secrets for untrusted PR code.

### Integration tests

Use dedicated development/sandbox Cloudflare resources where possible.

Tests should verify:

- read succeeds with read scope
- write fails with read-only scope
- production write requires correct policy
- destructive call is denied/approval-gated
- secrets are redacted from logs
- invalid auth is rejected
- upstream timeout is handled
- retry policy is bounded
- audit event is written

### Deployment

Preferred early deployment strategy:

- deployment initiated manually from trusted operator context or controlled script
- pull approved revision on A1
- install/build
- run tests
- restart service
- health check
- verify MCP handshake through edge
- rollback if health verification fails

Because GitHub Actions quota/cost may vary and the repo is public, do not make production deployment depend exclusively on a privileged public-repo self-hosted runner.

A self-hosted runner may be introduced later only with a reviewed threat model and restricted workflow/runner access.

---

## 21. Testing matrix

### Protocol tests

- initialize
- tools/list
- tools/call
- malformed request
- invalid protocol version
- unsupported operation
- cancellation/timeout where supported

### Auth tests

- no token
- expired token
- wrong audience
- missing scope
- valid read scope
- valid write scope
- destructive operation without approval

### Provider tests

Cloudflare:

- zones
- DNS
- Workers/Pages
- Tunnel discovery
- safe DNS mutation in sandbox

GitHub:

- repo read
- branch/PR lifecycle in test repo

Oracle:

- health
- allowlisted service restart
- forbidden service name

### Failure tests

- Cloudflare unavailable
- GitHub rate limited
- origin network failure
- provider auth revoked
- audit sink unavailable
- client disconnect

---

## 22. Observability

Minimum production observability:

- structured logs
- request ID
- actor/client
- tool name
- target
- policy decision
- latency
- upstream error class
- health status

Metrics to add later:

- calls per tool
- denied calls
- provider error rate
- p50/p95 latency
- auth failures
- approval-required count
- service restarts

Do not place prompts, secrets, tokens, or entire sensitive response bodies into metrics labels.

---

## 23. Repository governance

### Public repository rule

The code may remain public, but assume attackers can read every implementation detail.

Security must depend on secrets, identity, scopes, policy, network controls, and authorization — never obscurity.

### Branch/PR workflow

After this initial bootstrap commit:

- normal development occurs on feature branches
- changes enter `main` through PRs where practical
- provider permission expansions deserve explicit review
- security-sensitive changes require tests

### Documentation as contract

Architecture/security docs must change in the same PR as behavior when relevant.

---

## 24. Implementation phases for Claude

Claude should execute this plan in order. Do not jump directly to unrestricted Cloudflare mutation.

### Phase 0 — Repository foundation

Deliverables:

- `README.md`
- `CLAUDE.md`
- TypeScript/selected SDK workspace
- folder structure
- formatting/lint/typecheck/test config
- `.gitignore`
- `.env.example` with names only, never values
- architectural docs
- basic CI safe for a public repo

Gate:

```text
clean install
lint passes
typecheck passes
unit test skeleton passes
no secrets in git
```

### Phase 1 — Minimal authenticated remote MCP

Deliverables:

- one minimal MCP service
- Streamable HTTP `/mcp`
- authentication boundary
- `health` or equivalent safe diagnostic endpoint
- one harmless tool such as `tn_status`
- local + A1 test procedure

Gate:

Claude Code can connect remotely and call only the harmless tool.

### Phase 2 — A1 deployment

Deliverables:

- systemd units
- environment layout
- localhost binding
- deployment script
- service account/permissions
- logs
- restart/recovery test

Gate:

Service survives process crash/reboot and is reachable locally only.

### Phase 3 — Cloudflare Tunnel + edge security

Deliverables:

- `mcp.telosnexus.cloud`
- Tunnel route to local gateway
- no direct public MCP origin port
- Access/OAuth policy
- valid TLS endpoint

Gate:

Authorized Claude connects; unauthenticated client is rejected.

### Phase 4 — Cloudflare read-only provider

Deliverables:

- provider client
- account/zone discovery
- DNS read tools
- Workers/Pages/Tunnel reads
- audit log
- permission tests

Gate:

No provider write credential is necessary to pass Phase 4.

### Phase 5 — Cloudflare safe writes

Deliverables:

- scoped write permission
- DNS upsert with validation
- approved deployment workflow(s)
- R1/R2 policy
- sandbox integration tests

Gate:

A reversible sandbox change succeeds, is audited, then is reverted.

### Phase 6 — Destructive approval boundary

Deliverables:

- R3 classification
- explicit approval mechanism or hard-disable
- tests proving denial

Gate:

Agent cannot perform destructive action merely by asking the generic provider layer.

### Phase 7 — GitHub MCP

Implement read first, then policy-controlled write.

### Phase 8 — Oracle MCP

Implement allowlisted operational tools; no unrestricted shell by default.

### Phase 9 — Telos-control MCP

Add cross-provider Telos workflows and domain/runtime policies.

### Phase 10 — JARVIS integration

Give JARVIS a dedicated identity and smallest useful initial permission set.

---

## 25. Non-goals for the first release

Do not waste Phase 1 effort on:

- a large web dashboard
- dozens of providers
- autonomous destructive remediation
- Kubernetes
- a complex distributed message bus
- multi-region deployment
- custom LLM hosting
- replacing Jarvis
- automatic migration of every existing Telos hostname

First release success is:

> **Claude Code securely reaches an authenticated TN MCP on A1 through Cloudflare, reads Telos Cloudflare state, and can perform a narrowly scoped audited reversible action.**

---

## 26. Information/actions required from Qasim

Claude must not ask Qasim for everything at once. Most repository work can be completed without credentials.

Qasim is required only at trust-boundary steps.

### Required A — Oracle A1 access

Claude needs one of these operator paths:

- an existing Claude Code session running on the A1 VM, **or**
- SSH access provided locally by Qasim to the Claude/operator environment.

Do not put SSH private keys in this repository.

Claude should first collect non-secret environment facts itself:

```text
OS/version
architecture
available RAM/disk
Node/Python versions
systemd state
cloudflared state
existing listening ports
existing Telos services/tunnels
```

### Required B — Cloudflare account authorization

At Phase 3/4, Qasim must authorize Cloudflare access.

Preferred order:

1. OAuth to Cloudflare where the chosen official MCP/client flow supports it.
2. Otherwise create a **scoped API token** for TN-MCPs.

Do not send the token in chat or commit it to GitHub. Enter it directly on the A1 VM into the protected environment/secret location.

Start with read-only permissions. Claude must tell Qasim the exact additional scope before asking him to expand permissions.

### Required C — DNS/Tunnel approval

Qasim must approve creation/use of:

```text
mcp.telosnexus.cloud
```

The implementation should avoid disturbing existing Telos Tunnel routes.

### Required D — Authentication identity

For the first production operator identity, use Qasim's normal trusted identity through Cloudflare Access/OAuth.

Claude should present the exact configuration it plans before applying account-wide Access changes.

### Required E — GitHub credential later

Not needed for the Cloudflare MVP.

When GitHub MCP work begins, Qasim may need to authorize a GitHub App or create a restricted credential. Do not request this during Phase 0–4 unless necessary.

---

## 27. Specific instructions to Claude Code

When Qasim tells Claude to implement this repository, Claude should follow these operator rules:

1. **Read this complete document first.**
2. Verify current upstream docs/SDK versions before coding.
3. Inspect the A1 host before choosing ports/process layout.
4. Preserve existing production services and existing Cloudflare Tunnel routes.
5. Never commit credentials.
6. Never request the Cloudflare Global API Key.
7. Start Cloudflare integration read-only.
8. Build tests before enabling provider writes.
9. Use Streamable HTTP for the remote MCP endpoint.
10. Bind origin services to localhost and expose them using Cloudflare Tunnel.
11. Apply authentication/authorization before production tools.
12. Keep provider MCPs separated even if they share packages.
13. Implement structured audit logs before write operations.
14. Treat destructive tools as approval-required or disabled.
15. Do not expose unrestricted shell as a normal tool.
16. Do not make Claude the owner/controller of JARVIS. Claude is an operator/client.
17. Commit work in logical phases with descriptive commits.
18. Update this document/status docs if implementation reality changes.
19. At every phase gate, run tests and show concrete evidence.
20. Stop only when a real Qasim trust-boundary action is required; do not ask him to perform tasks Claude can do itself.

---

## 28. First Claude execution prompt

Qasim can give Claude Code this instruction after cloning/pulling the repository:

```text
Read docs/TN_MCPS_MASTER_IMPLEMENTATION_PLAN.md completely.

You are the implementation engineer for TN-MCPs. Treat the document as the architecture and security contract. First inspect the repository and current official MCP/Cloudflare/Claude SDK documentation, then implement Phase 0 and Phase 1 only unless their gates pass cleanly.

TN-MCPs is a multi-MCP Telos Nexus control-plane project, not a single Cloudflare script. Use a structure that can support Cloudflare, GitHub, Oracle, and Telos-control MCPs with shared auth/policy/audit packages.

Use the modern MCP remote transport (Streamable HTTP), no committed secrets, no Global Cloudflare API key, and no unrestricted shell tool. Production origin services must be designed to bind to localhost and later be exposed through Cloudflare Tunnel.

Run all tests/lint/typecheck and commit the implementation in logical commits. If you need Qasim to perform a trust-boundary action, state exactly one required action, why it is required, and the minimum permission/credential needed. Do not ask him for information you can inspect yourself.
```

After Phase 1 passes, Claude proceeds to the A1 deployment phase using the same document.

---

## 29. Initial credential/scopes philosophy

Do not pre-authorize everything.

Start:

```text
Claude Code -> TN MCP:
    tn:read
    cloudflare:read
```

Then add narrowly when required:

```text
cloudflare:dns:write
cloudflare:deploy:write
cloudflare:tunnel:write
```

Destructive/admin remains separate:

```text
admin:destructive
```

No normal client should receive `admin:destructive` by default.

---

## 30. Definition of done for the Cloudflare MVP

The Cloudflare MVP is complete only when all of the following are true:

- [ ] TN-MCPs has a reproducible build
- [ ] tests/lint/typecheck pass
- [ ] remote MCP uses Streamable HTTP
- [ ] A1 service binds locally
- [ ] service runs under supervision
- [ ] `mcp.telosnexus.cloud` resolves through Cloudflare
- [ ] Cloudflare Tunnel carries the origin connection
- [ ] no public origin MCP port is required
- [ ] authentication is required
- [ ] Claude Code can authenticate/connect
- [ ] read-only Cloudflare tools work
- [ ] tool calls are audited
- [ ] secrets are redacted
- [ ] write scope is separate from read scope
- [ ] at least one safe reversible write is tested in a non-destructive target
- [ ] destructive operation is denied or approval-gated
- [ ] existing Telos production DNS/routes remain intact
- [ ] restart/reboot recovery is verified
- [ ] rollback procedure is documented

---

## 31. Security invariants that must never be relaxed silently

1. No secrets in Git.
2. No Cloudflare Global API Key.
3. No unauthenticated production administrative MCP.
4. No unrestricted production shell tool for routine agents.
5. No automatic destructive actions.
6. No cross-provider super-token when separate identities are possible.
7. No direct public A1 MCP port if Tunnel can provide the edge.
8. No production write without auditability.
9. No broad permission expansion without documenting why.
10. No coupling the Telos control plane to one LLM vendor.

---

## 32. Future MCP candidates

Once the foundation is stable, this repository may host or integrate additional MCPs such as:

- Google Workspace
- Firebase / Google Cloud
- Notion
- Telegram management where APIs permit
- Telos Nexus application backends
- monitoring/observability
- database administration with strict policy
- IoT/industrial telemetry read layers
- selected deployment systems
- internal documentation/search

Every provider must follow the same rules: isolation, least privilege, audit, explicit destructive boundary, and a stable Telos-owned abstraction where valuable.

---

## 33. Final architecture principle

The objective is not to give Claude "full control of everything."

The objective is to create a **well-governed machine interface through which trusted AI clients can operate Telos Nexus infrastructure safely and repeatably**.

That distinction is essential.

The system should eventually allow Qasim to switch from Claude to another capable model without rebuilding the infrastructure integrations. The durable asset is `TN-MCPs` + Telos policy + Jarvis orchestration — not the current model vendor.
