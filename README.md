# TN-MCPs

**Telos Nexus MCP platform.** The monorepo for the Telos Nexus
[Model Context Protocol](https://modelcontextprotocol.io) control plane: separate MCP
servers per provider behind a thin authenticated gateway. Through it, AI clients (Claude
Code, Codex/OpenAI clients, JARVIS, future agents) get **policy-checked, audited,
approval-gated** access to Telos Nexus infrastructure. Cloudflare comes first, then
GitHub, Oracle, and Telos workflow tools.

```
AI clients ──HTTPS──▶ mcp.telosnexus.cloud/<provider>/mcp
                        │  Cloudflare Access (one path-scoped app per provider)
                        ▼
                      Cloudflare Tunnel (dedicated)
                        │
   A1 VM, loopback only ▼
     gateway :8790   Host/Origin · routing · request IDs · rate limits · JWT check · approvals
        ├─▶ mcps/cloudflare     :8701   Cloudflare credentials only
        ├─▶ mcps/github         :8702   GitHub App only           (later)
        ├─▶ mcps/oracle         :8703   OCI, allowlisted ops only (later)
        └─▶ mcps/telos-control  :8704   semantic Telos workflows  (later)
   shared: auth · policy (R0–R3, scopes, domain registry) · audit · approvals · config · observability
```

TN-MCPs does not re-implement provider APIs. It wraps official APIs and official MCP
servers in a Telos Nexus policy, audit, and approval layer. Models are replaceable
clients. The durable asset is TN-MCPs plus Telos policy.

## Status

**Phase 1 (of phases 0–15): repository foundation.** Nothing is deployed and
`mcp.telosnexus.cloud` does not exist yet. The owner's architecture and security
contract is [docs/TN_MCPS_MASTER_IMPLEMENTATION_PLAN.md](docs/TN_MCPS_MASTER_IMPLEMENTATION_PLAN.md).
The phased execution plan that implements it, including the owner-approved deviations,
is [docs/MASTER_PLAN.md](docs/MASTER_PLAN.md). Current phase: **2: thin gateway + first
MCP skeleton** (local only).

## Stack

| | |
| --- | --- |
| Runtime | Node.js 24 LTS |
| Language | TypeScript 7 (strict, ESM, NodeNext) |
| MCP | Official TypeScript SDK v2 (`@modelcontextprotocol/server`, `@modelcontextprotocol/node`), spec revision **2026-07-28**, dual-era (also serves 2025-11-25 clients) |
| Workspace | pnpm 12 workspaces (`packages/*`, `mcps/*`, `gateway`) |
| Lint / format | Biome 2 |
| Tests | Vitest 5 |
| Host | Oracle Cloud A1 (arm64), native systemd services, Cloudflare Tunnel ingress, no open inbound ports |

The reasoning behind each choice is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Develop

```bash
pnpm install          # uses the committed lockfile; dependency build scripts stay blocked
pnpm run check        # THE gate: biome ci + tsc -b + vitest + secret guard
pnpm test             # tests only
pnpm run format       # apply formatting
```

Requires Node 24 (`.node-version`) and pnpm 12 (`packageManager` in `package.json`).

## Layout

```
packages/shared/     redaction + typed config loading (Phase 1)
scripts/             guard-secrets.mjs, the repo-local secret gate
docs/                owner contract, master plan, architecture, security, deployment, Cloudflare, Claude Code
.github/             CI on GitHub-hosted runners (read-only token), Dependabot
```

Each phase creates the directories it needs: `gateway/`, `mcps/cloudflare/`,
`packages/mcp-common/`, `packages/policy/`, `deploy/`, and so on. See ARCHITECTURE §10.

## Documentation

- [docs/TN_MCPS_MASTER_IMPLEMENTATION_PLAN.md](docs/TN_MCPS_MASTER_IMPLEMENTATION_PLAN.md): the owner's architecture and security contract
- [docs/MASTER_PLAN.md](docs/MASTER_PLAN.md): phased execution plan, contract mapping, deviations, owner actions
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): system design and decisions
- [docs/SECURITY.md](docs/SECURITY.md): rules, threat model, credential isolation, R0–R3
- [docs/DEPLOYMENT_A1.md](docs/DEPLOYMENT_A1.md): the Oracle A1 host and how TN-MCPs will run on it
- [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md): Cloudflare ingress, the Cloudflare MCP, the domain policy
- [docs/CLAUDE_CODE.md](docs/CLAUDE_CODE.md): connecting Claude Code
- [CLAUDE.md](CLAUDE.md): instructions for AI engineers working in this repo

## Security

This repository is public. It contains no credentials and never will. Credentials live
on the host in per-process permissioned files and are documented by location only
([docs/SECURITY.md](docs/SECURITY.md) §3). If you believe you have found a secret or a
vulnerability here, do not open a public issue. Contact the repository owner directly
through GitHub.
