# Cloudflare

How TN-MCPs uses Cloudflare. Cloudflare is both the **ingress** (DNS, Tunnel, Access)
and the **first provider**: `mcps/cloudflare`, a separate MCP server process at
`https://mcp.telosnexus.cloud/cloudflare/mcp` (loopback `127.0.0.1:8701`, unit
`tn-mcp-cloudflare.service`, user `tnmcp-cloudflare`). Verified 2026-09-15 against
developers.cloudflare.com. Re-verify before each Cloudflare phase, because Cloudflare
reorganizes its docs often. The Tunnel docs moved to `developers.cloudflare.com/tunnel/`,
and the Access MCP docs moved under `cloudflare-one/access-controls/ai-controls/`.

The owner's contract ([TN_MCPS_MASTER_IMPLEMENTATION_PLAN.md](TN_MCPS_MASTER_IMPLEMENTATION_PLAN.md)
§5–§7, §14) defines the CF-0/CF-1/CF-2 progression, the hybrid integration strategy, and
the domain policy that this document implements.

## 1. Current state (observed, read-only)

- `telosnexus.cloud` uses Cloudflare nameservers. `mcp.telosnexus.cloud` has **no DNS
  record** yet.
- The A1 VM already runs one **remotely-managed** Cloudflare Tunnel for another Telos
  Nexus service. **TN-MCPs does not modify, reuse, or restart it.**
- No Cloudflare API token for TN-MCPs exists yet. No Cloudflare API calls were made
  while bootstrapping this repository.

## 2. Cloudflare's own MCP servers

Source: https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/

| Server | Endpoint | Use in TN-MCPs |
| --- | --- | --- |
| **Cloudflare API** (whole API via Code Mode: `search`, `execute`) | `https://mcp.cloudflare.com/mcp` | Upstream for `cf_api_search` (R0) and the gated `cf_api_execute` (§3) |
| Documentation | `https://docs.mcp.cloudflare.com/mcp` | In `.mcp.json` for engineers. Public, no auth |
| Audit Logs | `https://auditlogs.mcp.cloudflare.com/mcp` | Candidate for incident review (Phase 8) |
| DNS Analytics | `https://dns-analytics.mcp.cloudflare.com/mcp` | Candidate R0 tool |
| Observability, Workers Builds, Workers Bindings, Radar, Containers, Browser Run, Logpush, AI Gateway, AI Search, DEX, CASB, GraphQL | `https://<name>.mcp.cloudflare.com/mcp` (see source) | Not planned |

Authentication to Cloudflare's servers: **OAuth** (the user picks the permissions to
grant) or an **API token** as `Authorization: Bearer <token>`. Both user and account
tokens work. Tokens with **Client IP Address Filtering are not currently supported**
(https://github.com/cloudflare/mcp).

The Cloudflare API server's `execute()` runs model-written JavaScript in an isolated
Worker that calls `cloudflare.request()`. It **can create, modify, and delete
resources**. It has no documented read-only mode, and the credential is the only
restriction on the upstream side.

## 3. Provider design (the owner's "recommended hybrid")

- **Curated tools** use the official `cloudflare` TypeScript SDK (npm `cloudflare`,
  v7.1.0 on 2026-09-15, repo `cloudflare/cloudflare-typescript`). R0 tools use a
  **GET-only client** (MASTER_PLAN B3). Each tool maps to fixed endpoints, so the policy
  layer can classify it exactly.
- **Upstream adapter.** It forwards only the upstream tool names `search` and `execute`
  (B10), using a server-side credential and never the client's:
  - `cf_api_search` (R0) searches the OpenAPI spec to find endpoints. It calls nothing
    on the account.
  - `cf_api_execute` is the contract's "generic provider API behind an advanced/admin
    boundary". It is **disabled by default**. When enabled it requires the scope
    `cloudflare:admin` and a **per-call out-of-band owner approval that shows the exact
    JavaScript** and binds its code hash. It is treated as R3 whatever token it uses.
    It uses Token B (read-only) unless the owner explicitly provisions a write-capable
    token for it.
- **Telos workflow tools** (the owner contract's preferred normal path) live in
  `mcps/telos-control` (Phase 13) and call Cloudflare through policy:
  `tn_check_domain_architecture`, `tn_attach_domain`, `tn_route_runtime`,
  `tn_publish_company_site`.

**CF-0: R0 tools (Phase 5).** All list tools take `cursor`/`limit` and return
`{ items, nextCursor, truncated }`:

| Tool | Endpoint family | Notes |
| --- | --- | --- |
| `cf_account_overview` | accounts, zone count, tunnel count | Summary only |
| `cf_list_zones` | `GET /zones` | |
| `cf_list_dns_records` | `GET /zones/{zone_id}/dns_records` | Requires `zone` (name or id); filters by type/name |
| `cf_list_pages_projects` | `GET /accounts/{id}/pages/projects` | |
| `cf_list_workers` | `GET /accounts/{id}/workers/scripts` | Metadata only, never script bodies |
| `cf_list_tunnels` | `GET /accounts/{id}/cfd_tunnel` | Names, status, connections. Never tunnel tokens |
| `cf_list_r2_buckets` | `GET /accounts/{id}/r2/buckets` | Names and metadata only |
| `cf_list_access_apps` | `GET /accounts/{id}/access/apps` (+ policies) | Applications and policies; no service-token secrets |
| `cf_api_search` | upstream `search` | Finds endpoints; calls nothing |

**CF-1: writes (Phase 9)**, each with `resources()` + `precondition()`. The risk is set
by the target's domain classification (§4.2): R1 for non-production targets, R2 for
production ones.

| Tool | Scope |
| --- | --- |
| `cf_upsert_dns_record` | `cloudflare:dns:write` |
| `cf_delete_dns_record` (one record; more than one is R3) | `cloudflare:dns:write` |
| `cf_deploy_pages` | `cloudflare:deploy:write` |
| `cf_deploy_worker` | `cloudflare:deploy:write` |
| `cf_update_tunnel_route` (the existing Telos tunnel is on a denylist) | `cloudflare:tunnel:write` |

**CF-2: R3 (never on the normal path).** Delete zone, change nameservers, delete a
production Worker/Pages project, delete R2 buckets or data, remove a tunnel protecting
production, change account-wide security controls, issue or revoke broad credentials,
bulk DNS edits. These need `admin:destructive` and a single-use owner approval every
time. They are hard-disabled in production until the Phase 8 approvals app exists, and
**not built** until a specific need is approved.

## 4. API tokens and domain policy

### 4.1 API tokens (Phase 5 and Phase 9)

Create **account-owned tokens** where possible (service principals that survive a user
leaving; creating them requires Super Administrator). Otherwise use user tokens.
**Never the Global API Key.** All three tokens are readable only by `tnmcp-cloudflare`,
in `/etc/tn-mcps/cloudflare/` ([DEPLOYMENT_A1.md](DEPLOYMENT_A1.md) §2). The gateway
and the other MCP servers never see them.

Sources: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/ ·
https://developers.cloudflare.com/fundamentals/api/reference/permissions/ ·
https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/

**Token A: `tn-mcps-read`** (curated R0 tools), file `cloudflare-read.token`

| Scope | Permission group |
| --- | --- |
| Account | Account Settings Read |
| Account | Cloudflare Tunnel Read |
| Account | Cloudflare Pages Read |
| Account | Workers Scripts Read |
| Account | Workers R2 Storage Read |
| Account | Access: Apps and Policies Read |
| Zone (all zones in the Telos account, or listed zones) | Zone Read |
| Zone | DNS Read |

Restrictions: Client IP Address Filtering = the VM's egress IP (Q8); TTL ≤ 90 days.

**Token B: `tn-mcps-read-upstream`** (upstream adapter), file
`cloudflare-read-upstream.token`: the same read groups, **without** IP filtering
(unsupported upstream), TTL ≤ 30 days. The cloudflare/mcp README notes account tokens
need an account-read permission for account auto-detection; confirm the exact group
name in the dashboard when creating it. MASTER_PLAN WP 5.0 (S7) tests it.

**Token C: `tn-mcps-write`** (Phase 9 only, after the Phase 8 exit and Q11), file
`cloudflare-write.token`: only the edit groups an approved tool needs (for example
`DNS Edit` on named zones), IP filtered, TTL ≤ 30 days. It is injected only into R1/R2
tool definitions.

The owner creates tokens in the dashboard and places them on the VM directly.
**Tokens are never pasted into chat or committed.**

### 4.2 Domain policy (proposed; the owner confirms in Q4)

Encoded as data in `packages/policy`. It validates R2 targets and decides R1 vs R2:

| Domain | Role (owner contract §7) | Classification |
| --- | --- | --- |
| `telosnexus.io` | canonical company identity | production |
| `telosnexus.co` | alias / redirect to `.io` | production |
| `telosnexus.services` | Services vertical | production |
| `telosnexus.app` | product catalogue / app family | production |
| `telosnexus.cloud` | cloud / runtime / infrastructure namespace | production for routes of live services |
| `telosnexus.space` | labs / research / experiments | non-production (R1-eligible) |

The registry is not a migration engine. Existing stable production URLs, OAuth
callbacks, Android App Links, QR codes, Firebase hosting, and public endpoints move
only through deliberate, separately approved migrations, never merely because `.cloud`
exists.

## 5. Tunnel (Phase 6)

Sources: https://developers.cloudflare.com/tunnel/ ·
https://developers.cloudflare.com/tunnel/reference/run-parameters/ ·
https://developers.cloudflare.com/tunnel/concepts/routing/

- A **new, dedicated, remotely-managed tunnel** named `tn-mcps`. A separate tunnel keeps
  TN-MCPs' lifecycle, restarts, and blast radius independent of the existing production
  tunnel.
- Published applications point **only at the gateway**:
  `mcp.telosnexus.cloud → http://127.0.0.1:8790` (Phase 6) and
  `approve.telosnexus.cloud → http://127.0.0.1:8790` (Phase 8), then the mandatory
  catch-all `http_status:404`. The gateway routes `/cloudflare/mcp`, `/github/mcp`,
  `/oracle/mcp`, and `/telos/mcp` to their loopback backends. No tunnel route reaches a
  backend port directly. Cloudflare creates the proxied DNS records
  (`<tunnel-uuid>.cfargotunnel.com`) automatically.
- Run as `cloudflared tunnel --no-autoupdate run --token-file
  /etc/tn-mcps/tunnel/tunnel.token` (`--token-file` needs cloudflared ≥ 2025.4.0) from
  the official package at `/usr/local/bin/cloudflared`, in `tn-mcp-tunnel.service`
  under `tnmcp-tunnel`. The unit isn't named `cloudflared.service` because a user-level
  unit with that name already serves another Telos service, and a same-named system unit
  would be confusing and collide with `cloudflared service install`.
- Egress: cloudflared needs outbound 7844 (TCP/UDP). No inbound rule is added.

## 6. Access (Phase 4 spike, Phase 6 production, Phase 8 approvals)

Sources: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/ ·
https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/ ·
https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/ ·
https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/ ·
https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/ ·
https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/

- **One path-scoped Access application per MCP server** (`mcp.telosnexus.cloud/cloudflare`,
  `/github`, `/oracle`, `/telos`), each with its own policy and AUD tag, so a token
  issued for one provider can't reach another. **Managed OAuth** is enabled on each
  (Zero Trust → Access controls → Applications → *app* → Edit → Advanced settings →
  Managed OAuth; API field `oauth_configuration.enabled`). Access becomes the OAuth 2.0
  authorization server, with discovery on the hostname and dynamic client registration.
  Tokens are opaque. Policies: **Allow** for the owner's email; **Service Auth** for each
  machine client's service token (JARVIS only on the apps it needs).
  MASTER_PLAN S11 tests that Managed OAuth works with path-scoped apps and that Claude
  Code sends the full path URL as the RFC 8707 resource. If not, the fallback is
  single-label hosts (`mcp-cloudflare.telosnexus.cloud`, …), not two-level names, which
  a standard one-level wildcard edge certificate doesn't cover.
- **Approvals app** (`approve.telosnexus.cloud`, Phase 8): a **separate** Access
  application with its own AUD, owner-only Allow policy, IdP MFA, and session ≤ 10
  minutes. No Managed OAuth and no service tokens: only a human in a browser can use it.
- The gateway (before proxying) and the destination MCP server (again) validate
  `Cf-Access-Jwt-Assertion`: JWKS `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`,
  `iss` = team domain, `aud` (array) contains the route's AUD, `type` = `app`, RS256.
  Claim shapes: users carry `email` + non-empty `sub`; service tokens carry
  `common_name` (= Client ID) and an empty `sub`. Keys rotate every 6 weeks, and the
  previous key stays valid 7 days.
- Cloudflare warns: "Only enable Managed OAuth for MCP servers that validate the Access
  JWT sent by Cloudflare". Both layers do, and neither sends OAuth challenges of its own.
- **Fallback:** an MCP server portal (Zero Trust → Access controls → AI controls → MCP
  portals). It supports stateless 2026-07-28 and 2025 Streamable HTTP clients, per-tool
  enable/disable (`default_disabled` + `updated_tools`), and tool-call logs
  (`mcp_portal_logs`). Limitation: portals don't enforce independent MFA, purpose
  justification, or temporary authentication for servers behind them.

## 7. Phase 4 spike: prove the auth path before any exposure

- **Step A** (zero infrastructure): an MCP portal whose only upstream is the public
  Cloudflare Docs server. Connect Claude Code
  (`claude mcp add --transport http --scope local cf-portal-spike https://<portal-host>/mcp`,
  then `claude mcp login cf-portal-spike`) and call a docs tool.
- **Step B** (the real test): two path-scoped Access apps with Managed OAuth on a
  throwaway hostname (`mcp-spike.telosnexus.cloud/a` and `/b`), each in front of a
  minimal SDK v2 MCP route on a throwaway Worker that reports which Access claim
  **names** it received. Record S1, S2, S8, S9, and S11 (MASTER_PLAN A.2): each
  resource keeps its full path, and a token for `/a` is refused on `/b`. Delete
  everything afterwards.

The owner creates the resources with click-by-click steps supplied at that time.

## 8. Must not happen

- No zone creation or deletion, nameserver change, or DNS change outside an approved phase.
- No change to the existing Telos Nexus tunnel or its DNS records.
- No token broader than §4.1. No Global API Key. No token in chat.
- No write-capable token on the VM before the Phase 8 exit and Q11.
- `cf_api_execute` stays disabled unless the owner explicitly enables it, and never runs
  without an exact-code approval.
