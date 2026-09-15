# Claude Code integration

How Claude Code (and engineers using it) connect to the Telos Nexus MCP servers, and
how this repository is configured for Claude Code sessions.

Verified against the official docs on 2026-09-15 with Claude Code 2.1.272 installed
on the A1 VM. Re-verify before Phase 7. Sources are listed at the end.

## 1. Endpoints and registration (Phase 7, not yet live)

TN-MCPs exposes **one MCP server per provider**, all through the gateway
([ARCHITECTURE.md](ARCHITECTURE.md) §2). None of these exist yet; don't register them
until the Phase 6 exit criteria are met ([MASTER_PLAN.md](MASTER_PLAN.md)).

| Claude Code name | URL | Phase |
| --- | --- | --- |
| `telos-cloudflare` | `https://mcp.telosnexus.cloud/cloudflare/mcp` | 6–7 |
| `telos-github` | `https://mcp.telosnexus.cloud/github/mcp` | 10 |
| `telos-oracle` | `https://mcp.telosnexus.cloud/oracle/mcp` | 11 |
| `telos-control` | `https://mcp.telosnexus.cloud/telos/mcp` | 13 |

The documented syntax for a remote Streamable HTTP server is:

```bash
# Project scope: writes the entry to .mcp.json (shared through git, no credentials)
claude mcp add --transport http --scope project telos-cloudflare https://mcp.telosnexus.cloud/cloudflare/mcp

# User scope: your own machine, every project
claude mcp add --transport http --scope user telos-cloudflare https://mcp.telosnexus.cloud/cloudflare/mcp
```

Options go **before** the server name. Scopes are `local` (default; this project,
private to you), `project` (`.mcp.json`, committed), and `user` (all your projects).
Register only the servers you need. A session that only needs GitHub shouldn't carry
the Cloudflare server (owner contract §4, "Why separate servers?").

Authentication is OAuth, not a header we paste. An unauthenticated request gets `401`
with a `WWW-Authenticate` challenge from Cloudflare Access. Claude Code then runs OAuth
discovery (RFC 9728 protected resource metadata, then RFC 8414 authorization server
metadata), registers itself (Dynamic Client Registration or a Client ID Metadata
Document, both discovered automatically), and opens a browser for sign-in:

```bash
claude mcp login telos-cloudflare     # from a shell
/mcp                                  # inside a session → select the server → Authenticate
claude mcp logout telos-cloudflare    # clear stored credentials
```

Each provider path is its own Access application with Managed OAuth
([CLOUDFLARE.md](CLOUDFLARE.md) §6), so each server is a separate login and a separate
OAuth resource. Access, not TN-MCPs, issues the challenge and serves the discovery
documents. No password or token is ever typed into Claude Code or into chat.
MASTER_PLAN WP 4.0 tests the flow (S1, S8, S9, S11) before we rely on it.

### Local development gate (Phase 2, WP 2.5)

On the VM only, against the local gateway with the development authenticator:

```bash
# the operator loads the protected local dev token into TN_DEV_TOKEN first; never commit or paste it
claude mcp add --transport http --scope local tn-local http://127.0.0.1:8790/cloudflare/mcp --header "Authorization: Bearer ${TN_DEV_TOKEN}"
```

Claude Code must see and call only `tn_status`. Remove the registration
(`claude mcp remove tn-local`) and unset the variable afterwards.

## 2. `.mcp.json` rules for this repository

The committed [`.mcp.json`](../.mcp.json) is **public**, because the repo is. Rules:

1. No credentials, ever: not tokens, not client secrets, and no internal URLs that
   reveal infrastructure beyond what public DNS already shows.
2. If a header is ever needed, it uses environment expansion only:
   `"Authorization": "Bearer ${SOME_VAR}"`. The `scripts/guard-secrets.mjs` gate
   rejects any literal `Authorization` value in `.mcp.json`.
3. Prefer OAuth servers (no header at all) over header auth.
4. Only add servers that help engineers working **on this repository**.

Current contents: the Cloudflare documentation MCP server
(`https://docs.mcp.cloudflare.com/mcp`: public, read-only, no authentication;
an unauthenticated `initialize` succeeded on 2026-09-15). It lets a Claude Code session
look up current Cloudflare docs while building the Cloudflare MCP. `telos-cloudflare`
will be added in Phase 7.

Claude Code asks for approval before using any project-scoped server from
`.mcp.json` in an interactive session (status `⏸ Pending approval`). Headless
`claude -p` runs load them without asking, so keep `.mcp.json` limited to low-risk
servers. Reset your choices with `claude mcp reset-project-choices`.

Environment expansion supported in `.mcp.json`: `${VAR}` and `${VAR:-default}` in
`url`, `headers`, `command`, `args`, `env`.

## 3. Protocol version compatibility

The current MCP specification is **2026-07-28**: stateless, with no `initialize`
handshake, `server/discover`, per-request `_meta`, and required `Mcp-Method` /
`Mcp-Name` headers. Claude Code has two MCP client runtimes:

| Runtime | When it is used | What it speaks to HTTP servers |
| --- | --- | --- |
| v2 (MCP TS SDK 2.0) | default on Claude Code ≥ 2.1.232 with a first-party login | asks the server whether it supports 2026-07-28 and uses it if so; otherwise the 2025-11-25 handshake |
| v1 (MCP TS SDK 1.x) | Bedrock/Vertex/Foundry, Claude apps gateway, feature flags off | 2025-11-25 `initialize` handshake only |

Override with `MCP_SDK_GENERATION=v1|v2` and `MCP_PROTOCOL_NEGOTIATION=auto|legacy`
(documented on the Claude Code MCP page, and present in the installed 2.1.272 binary.
The env-vars reference page may not list them).

**Consequence:** every TN-MCPs server is *dual-era*. It serves 2026-07-28 requests
statelessly **and** answers legacy `initialize`-based clients. `packages/mcp-common`
uses the official SDK's `createMcpHandler`, which does this by default
(`legacy: 'stateless'`). Setting `legacy: 'reject'` would break every v1-runtime client,
other agents, and older tooling. See [ARCHITECTURE.md](ARCHITECTURE.md) §5.

## 4. Permissions and approvals in Claude Code

- MCP tools are addressed as `mcp__<server>__<tool>`, e.g.
  `mcp__telos-cloudflare__cf_list_zones`. Allow/deny rules in `.claude/settings.json`
  use these names.
- Claude Code's own permission prompt is a **convenience, not a control**. The server's
  policy layer ([SECURITY.md](SECURITY.md) §5) is the authority: an R2/R3 tool is refused
  server-side unless its scope and approval requirements are met, whatever the client
  allowed. Only the owner approves, in the separate approvals app. A Claude session
  never can.
- R1–R3 tools also carry `_meta: { "anthropic/requiresUserInteraction": true }` so
  Claude Code asks every time, plus MCP `annotations` (`readOnlyHint`,
  `destructiveHint`, `idempotentHint`, `openWorldHint`) consistent with their risk.
- Output limits: Claude Code warns above 10,000 tokens and caps MCP tool output at
  25,000 tokens by default (`MAX_MCP_OUTPUT_TOKENS`). TN-MCPs caps results at 48 KiB and
  paginates list tools (`cursor`, `limit`, `truncated`). A tool can raise the client
  cap with `_meta["anthropic/maxResultSizeChars"]`, but use that sparingly.

Suggested `.claude/settings.json` for engineers on this repo (Phase 7): allow R0, ask for
R1/R2.

```json
{
  "permissions": {
    "allow": ["mcp__telos-cloudflare__cf_list_zones", "mcp__telos-cloudflare__cf_list_dns_records"],
    "ask": ["mcp__telos-cloudflare__cf_upsert_dns_record"],
    "deny": []
  }
}
```

## 5. Debugging

```bash
claude mcp list                        # every configured server and its status
claude mcp get telos-cloudflare        # one server's config and status
claude --debug                         # verbose session log, including MCP traffic
MCP_TIMEOUT=10000 claude               # connection timeout (ms)
MCP_TOOL_TIMEOUT=600000 claude         # per-tool-call timeout (ms)
claude --strict-mcp-config --mcp-config ./some.json   # only the servers you pass
```

Status indicators: `✔ Connected`, `! Needs authentication`, `✘ Failed to connect`,
`⏸ Pending approval`, `✘ Rejected`, `⊘ Disabled for this project`.

Endpoint checks (Phase 6+):

```bash
# Unauthenticated request: Access must answer 401 with a WWW-Authenticate challenge
curl -si -X POST https://mcp.telosnexus.cloud/cloudflare/mcp | grep -i www-authenticate
# Access Managed OAuth discovery document
curl -s https://mcp.telosnexus.cloud/.well-known/oauth-authorization-server
# On the VM only: gateway liveness (no auth, no internals)
curl -s http://127.0.0.1:8790/healthz
```

## 6. Using Claude Code to develop this repository

- Read the owner's contract
  ([TN_MCPS_MASTER_IMPLEMENTATION_PLAN.md](TN_MCPS_MASTER_IMPLEMENTATION_PLAN.md)) and
  [`CLAUDE.md`](../CLAUDE.md) first. CLAUDE.md holds the conventions and forbidden
  actions.
- The gate is `pnpm run check`. Nothing lands unless it exits 0.
- Never paste secrets into a session. If a value is needed, reference the path of the
  file that holds it (see [SECURITY.md](SECURITY.md) §3).

## Sources

- Claude Code MCP: https://code.claude.com/docs/en/mcp
- MCP versioning (current = 2026-07-28): https://modelcontextprotocol.io/specification/versioning
- MCP Streamable HTTP (2026-07-28): https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- MCP authorization (2026-07-28): https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- Cloudflare Access Managed OAuth: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/
- Cloudflare managed MCP servers: https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/
