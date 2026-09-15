# Cloudflare

How TN-MCPs uses Cloudflare. Cloudflare is both the **ingress** (DNS, Tunnel, Access)
and the **first provider** (tools that read and, later, change Cloudflare
configuration). Verified 2026-09-15 against developers.cloudflare.com. Re-verify before
each Cloudflare phase, because Cloudflare reorganizes its docs often. The Tunnel docs
moved to `developers.cloudflare.com/tunnel/`, and the Access MCP docs moved under
`cloudflare-one/access-controls/ai-controls/`.

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
| **Cloudflare API** (whole API via Code Mode: `search`, `execute`) | `https://mcp.cloudflare.com/mcp` | Upstream for `search` **only** (§3) |
| Documentation | `https://docs.mcp.cloudflare.com/mcp` | In `.mcp.json` for engineers. Public, no auth |
| Audit Logs | `https://auditlogs.mcp.cloudflare.com/mcp` | Candidate for incident review (Phase 8) |
| DNS Analytics | `https://dns-analytics.mcp.cloudflare.com/mcp` | Candidate read tool |
| Observability, Workers Builds, Workers Bindings, Radar, Containers, Browser Run, Logpush, AI Gateway, AI Search, DEX, CASB, GraphQL | `https://<name>.mcp.cloudflare.com/mcp` (see source) | Not planned |

Authentication to Cloudflare's servers: **OAuth** (the user picks the permissions to
grant) or an **API token** as `Authorization: Bearer <token>`. Both user and account
tokens work. Tokens with **Client IP Address Filtering are not currently supported**
(https://github.com/cloudflare/mcp).

The Cloudflare API server's `execute()` runs model-written JavaScript in an isolated
Worker that calls `cloudflare.request()`. It **can create, modify, and delete
resources**. It has no documented read-only mode, and the credential is the only
restriction.

## 3. Provider design

- **Curated tools** use the official `cloudflare` TypeScript SDK (npm `cloudflare`,
  v7.1.0 on 2026-09-15, repo `cloudflare/cloudflare-typescript`) through a **GET-only
  client** for read tools (MASTER_PLAN B3). Each tool maps to fixed endpoints, so the
  policy layer can classify it exactly.
- **Upstream search.** `cloudflare_api_search` proxies only the upstream `search` tool
  (OpenAPI-spec search, no account API calls), with server-side Token B. `execute` is
  **not** proxied (B10). Its safety would rest entirely on the token's permission
  groups staying correct in the dashboard, which is weaker than a code-level boundary.
  If `execute` is ever needed, it returns as a separate `write`-class tool behind
  approvals.

Phase 5 read tools (names final, inputs indicative; all take `cursor`/`limit` and
return `{ items, nextCursor, truncated }`):

| Tool | Endpoint family | Notes |
| --- | --- | --- |
| `cloudflare_account_overview` | accounts, zone count, tunnel count | Summary only |
| `cloudflare_list_zones` | `GET /zones` | |
| `cloudflare_get_dns_records` | `GET /zones/{zone_id}/dns_records` | Requires `zone` (name or id); filters by type/name |
| `cloudflare_get_pages_projects` | `GET /accounts/{id}/pages/projects` | |
| `cloudflare_get_workers` | `GET /accounts/{id}/workers/scripts` | Metadata only, never script bodies |
| `cloudflare_get_tunnels` | `GET /accounts/{id}/cfd_tunnel` | Names, status, connections. Never tunnel tokens |
| `cloudflare_get_r2_buckets` | `GET /accounts/{id}/r2/buckets` | Names and metadata only |
| `cloudflare_api_search` | upstream `search` | Finds endpoints; calls nothing |

Phase 9 write tools (each `write` or `destructive` per [SECURITY.md](SECURITY.md) §5,
each with `resources()` + `precondition()`): `cloudflare_dns_upsert`,
`cloudflare_dns_delete` (one record: write; more than one: destructive),
`cloudflare_pages_deploy`, `cloudflare_worker_deploy`, `cloudflare_tunnel_route_update`
(the existing Telos tunnel is on a denylist). Zone deletion, nameserver changes, R2
bucket deletion, Worker deletion, and tunnel deletion are `destructive` and are **not
built** until a specific need is approved.

## 4. API tokens (Phase 5 and Phase 9)

Create **account-owned tokens** where possible (service principals that survive a user
leaving; creating them requires Super Administrator). Otherwise use user tokens.
**Never the Global API Key.**

Sources: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/ ·
https://developers.cloudflare.com/fundamentals/api/reference/permissions/ ·
https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/

**Token A: `tn-mcps-read` (curated read tools)**

| Scope | Permission group |
| --- | --- |
| Account | Account Settings Read |
| Account | Cloudflare Tunnel Read |
| Account | Cloudflare Pages Read |
| Account | Workers Scripts Read |
| Account | Workers R2 Storage Read |
| Zone (all zones in the Telos account, or listed zones) | Zone Read |
| Zone | DNS Read |

Restrictions: Client IP Address Filtering = the VM's egress IP (Q8); TTL ≤ 90 days.

**Token B: `tn-mcps-read-upstream` (upstream `search`)**: same read groups, **without**
IP filtering (unsupported upstream), TTL ≤ 30 days. The cloudflare/mcp README notes
account tokens need an account-read permission for account auto-detection; confirm the
exact group name in the dashboard when creating it. MASTER_PLAN WP 5.0 (S7) tests it.

**Token C: `tn-mcps-write` (Phase 9 only, after the Phase 8 exit and Q11)**: only the
edit groups a specific approved tool needs (e.g. `DNS Edit` on named zones), IP
filtered, TTL ≤ 30 days.

Storage: `/etc/tn-mcps/gateway/*.token`, `root:tnmcp 0640`, read by path
([DEPLOYMENT_A1.md](DEPLOYMENT_A1.md) §2). The owner creates tokens in the dashboard and
places them on the VM directly. **Tokens are never pasted into chat or committed.**

## 5. Tunnel (Phase 6)

Sources: https://developers.cloudflare.com/tunnel/ ·
https://developers.cloudflare.com/tunnel/reference/run-parameters/ ·
https://developers.cloudflare.com/tunnel/concepts/routing/

- A **new, dedicated, remotely-managed tunnel** named `tn-mcps`. One tunnel could carry
  several hostnames, but a separate tunnel keeps TN-MCPs' lifecycle, restarts, and
  blast radius independent of the existing production tunnel.
- Published applications: `mcp.telosnexus.cloud → http://127.0.0.1:8787` (Phase 6) and
  `approve.telosnexus.cloud → http://127.0.0.1:8787` (Phase 8; the gateway routes by
  Host), then the mandatory catch-all `http_status:404`. Cloudflare creates the proxied
  DNS records (`<tunnel-uuid>.cfargotunnel.com`) automatically.
- Run as `cloudflared tunnel --no-autoupdate run --token-file
  /etc/tn-mcps/tunnel/tunnel.token` (`--token-file` needs cloudflared ≥ 2025.4.0) from
  the official package at `/usr/local/bin/cloudflared`, in the unit
  `tn-mcps-tunnel.service` under the user `tnmcp-tunnel`. It never shares the existing
  user-level `cloudflared.service` or its binary.
- Egress: cloudflared needs outbound 7844 (TCP/UDP). No inbound rule is added.

## 6. Access (Phase 4 spike, Phase 6 production, Phase 8 approvals)

Sources: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/ ·
https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/ ·
https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/ ·
https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/ ·
https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/ ·
https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/

- **MCP app** (`mcp.telosnexus.cloud`): **Managed OAuth** enabled (Zero Trust → Access
  controls → Applications → *app* → Edit → Advanced settings → Managed OAuth; API field
  `oauth_configuration.enabled`). Access becomes the OAuth 2.0 authorization server with
  discovery on the app hostname and dynamic client registration. Tokens are opaque.
  Policies: **Allow** for the owner's email; **Service Auth** for each machine client's
  service token.
- **Approvals app** (`approve.telosnexus.cloud`, Phase 8): a **separate** Access
  application with its own AUD tag, owner-only Allow policy, IdP MFA, and session ≤ 10
  minutes. No Managed OAuth and no service tokens: only a human in a browser can use it.
- The gateway validates `Cf-Access-Jwt-Assertion`: JWKS
  `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, `iss` = team domain, `aud`
  (array) contains the app's AUD, `type` = `app`, RS256. Claim shapes: users carry
  `email` + non-empty `sub`; service tokens carry `common_name` (= Client ID) and an
  empty `sub`. Keys rotate every 6 weeks, and the previous key stays valid 7 days.
- Cloudflare warns: "Only enable Managed OAuth for MCP servers that validate the Access
  JWT sent by Cloudflare". The gateway does, and doesn't send OAuth challenges of its own.
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
- **Step B** (the real test): an Access app with Managed OAuth on
  `mcp-spike.telosnexus.cloud` in front of a throwaway Worker running a minimal SDK v2
  MCP handler that reports which Access claim **names** it received. Record S1, S2, S8,
  and S9 (MASTER_PLAN A.2). Delete everything afterwards.

The owner creates the resources with click-by-click steps supplied at that time.

## 8. Must not happen

- No zone creation or deletion, nameserver change, or DNS change outside an approved phase.
- No change to the existing Telos Nexus tunnel or its DNS records.
- No token broader than the tables above. No Global API Key. No token in chat.
- No write-capable token on the VM before the Phase 8 exit and Q11. Upstream `execute`
  is never proxied.
