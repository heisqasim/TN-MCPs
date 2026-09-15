# Claude Code integration

How Claude Code (and engineers using it) connect to the Telos Nexus MCP gateway,
and how this repository is configured for Claude Code sessions.

Verified against the official docs on 2026-09-15 with Claude Code 2.1.272 installed
on the A1 VM. Re-verify before Phase 7. Sources are listed at the end.

## 1. Target registration (Phase 7, not yet live)

`https://mcp.telosnexus.cloud/mcp` **does not exist yet.** Do not register it until
the Phase 6 exit criteria are met (see [MASTER_PLAN.md](MASTER_PLAN.md)).

The documented syntax for a remote Streamable HTTP server is:

```bash
# Project scope: writes the entry to .mcp.json (shared through git, no credentials)
claude mcp add --transport http --scope project telos https://mcp.telosnexus.cloud/mcp

# User scope: your own machine, every project
claude mcp add --transport http --scope user telos https://mcp.telosnexus.cloud/mcp
```

Options go **before** the server name. Scopes are `local` (default; this project,
private to you), `project` (`.mcp.json`, committed), and `user` (all your projects).

Authentication is OAuth, not a header we paste. An unauthenticated request gets `401`
with a `WWW-Authenticate` challenge. Claude Code then runs OAuth discovery (RFC 9728
protected resource metadata at `/.well-known/oauth-protected-resource`, then RFC 8414
authorization server metadata at `/.well-known/oauth-authorization-server`), registers
itself (Dynamic Client Registration or a Client ID Metadata Document, both discovered
automatically), and opens a browser for sign-in. Trigger it with:

```bash
claude mcp login telos     # from a shell
/mcp                       # inside a session → select "telos" → Authenticate
claude mcp logout telos    # clear stored credentials
```

In this design the authorization server is **Cloudflare Access with Managed OAuth**
(see [ARCHITECTURE.md](ARCHITECTURE.md) §4). Access, not the gateway, issues the
challenge and serves the discovery documents. The browser sign-in is the Access login
page for the Telos Nexus Zero Trust team. No password or token is ever typed into
Claude Code or into chat. MASTER_PLAN Phase 4 (WP 4.0) tests whether Claude Code
completes this flow before we rely on it.

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
look up current Cloudflare docs while building the Cloudflare provider. The `telos`
gateway entry will be added in Phase 7.

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

**Consequence for the gateway:** it must be *dual-era*. It serves 2026-07-28 requests
statelessly **and** answers legacy `initialize`-based clients. The official SDK's
`createMcpHandler` does this by default (`legacy: 'stateless'`). A gateway configured
with `legacy: 'reject'` would break every v1-runtime client, other agents, and older
tooling. See [ARCHITECTURE.md](ARCHITECTURE.md) §3.

## 4. Permissions and approvals in Claude Code

- MCP tools are addressed as `mcp__<server>__<tool>`, e.g.
  `mcp__telos__cloudflare_list_zones`. Allow/deny rules in `.claude/settings.json`
  use these names.
- Claude Code's own permission prompt is a **convenience, not a control**. The
  gateway's policy engine ([SECURITY.md](SECURITY.md) §5) is the authority: a
  high-risk tool is refused server-side unless a valid approval exists, whatever the
  client allowed.
- Tools the gateway marks `write` or `destructive` also carry
  `_meta: { "anthropic/requiresUserInteraction": true }` so Claude Code asks every
  time, plus MCP `annotations` (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`).
- Output limits: Claude Code warns above 10,000 tokens and caps MCP tool output at
  25,000 tokens by default (`MAX_MCP_OUTPUT_TOKENS`). Provider tools must paginate and
  summarize instead of dumping full API responses. A tool can raise its own cap with
  `_meta["anthropic/maxResultSizeChars"]`, but use that sparingly.

Suggested `.claude/settings.json` for engineers on this repo (Phase 7):

```json
{
  "permissions": {
    "allow": ["mcp__telos__cloudflare_list_zones", "mcp__telos__cloudflare_get_dns_records"],
    "ask": ["mcp__telos__cloudflare_dns_upsert"],
    "deny": []
  }
}
```

## 5. Debugging

```bash
claude mcp list                 # every configured server and its status
claude mcp get telos            # one server's config and status
claude --debug                  # verbose session log, including MCP traffic
MCP_TIMEOUT=10000 claude        # connection timeout (ms)
MCP_TOOL_TIMEOUT=600000 claude  # per-tool-call timeout (ms)
claude --strict-mcp-config --mcp-config ./some.json   # only the servers you pass
```

Status indicators: `✔ Connected`, `! Needs authentication`, `✘ Failed to connect`,
`⏸ Pending approval`, `✘ Rejected`, `⊘ Disabled for this project`.

Endpoint checks (Phase 6+):

```bash
# Unauthenticated request: Access must answer 401 with a WWW-Authenticate challenge
curl -si -X POST https://mcp.telosnexus.cloud/mcp | grep -i www-authenticate
# Access Managed OAuth discovery document
curl -s https://mcp.telosnexus.cloud/.well-known/oauth-authorization-server
# On the VM only: gateway liveness (no auth, no internals)
curl -s http://127.0.0.1:8787/healthz
```

## 6. Using Claude Code to develop this repository

- Read [`CLAUDE.md`](../CLAUDE.md) first; it holds the conventions and forbidden actions.
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
