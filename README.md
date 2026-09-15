# TN-MCPs

**Telos Nexus MCP platform.** The monorepo for the Telos Nexus
[Model Context Protocol](https://modelcontextprotocol.io) control plane: one
authenticated MCP endpoint through which AI clients (Claude Code, Codex/OpenAI
clients, Jarvis, future agents) get **policy-checked, audited, approval-gated**
access to Telos Nexus infrastructure. Cloudflare comes first, then GitHub, Oracle
Cloud, Firebase, and internal Telos systems.

```
AI clients ──HTTPS──▶ mcp.telosnexus.cloud/mcp ──▶ Cloudflare Access ──▶ Cloudflare Tunnel
                                                                              │
             ┌──────────────── A1 VM (loopback only) ◀─────────────────────────┘
             ▼
     TN MCP gateway: authn · authz · policy · audit · approvals · rate limits
             │
             ├─▶ Cloudflare (official SDK + Cloudflare API MCP, read-only token)
             ├─▶ GitHub · Oracle · Firebase · Telos internal   (later phases)
```

TN-MCPs does not re-implement provider APIs. It wraps official APIs and official MCP
servers in a Telos Nexus policy, audit, and approval layer.

## Status

**Phase 1 (of phases 0–15): repository foundation.** Nothing is deployed and
`mcp.telosnexus.cloud` does not exist yet. The plan, phase by phase, is in
[docs/MASTER_PLAN.md](docs/MASTER_PLAN.md).

## Stack

| | |
| --- | --- |
| Runtime | Node.js 24 LTS |
| Language | TypeScript 7 (strict, ESM, NodeNext) |
| MCP | Official TypeScript SDK v2 (`@modelcontextprotocol/server`, `@modelcontextprotocol/node`), spec revision **2026-07-28**, dual-era (also serves 2025-11-25 clients) |
| Workspace | pnpm 12 workspaces |
| Lint / format | Biome 2 |
| Tests | Vitest 5 |
| Host | Oracle Cloud A1 (arm64), native systemd service, Cloudflare Tunnel ingress, no open inbound ports |

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
docs/                master plan, architecture, security, deployment, Cloudflare, Claude Code
.github/             CI on GitHub-hosted runners (read-only token), Dependabot
```

The phase that needs a directory creates it (`servers/gateway`, `packages/policy`,
`providers/cloudflare`, `deploy/`, …). See ARCHITECTURE §9.

## Documentation

- [docs/MASTER_PLAN.md](docs/MASTER_PLAN.md): authoritative phased plan, including owner actions
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): system design and decisions
- [docs/SECURITY.md](docs/SECURITY.md): rules, threat model, credential inventory, risk classes
- [docs/DEPLOYMENT_A1.md](docs/DEPLOYMENT_A1.md): the Oracle A1 host and how TN-MCPs will run on it
- [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md): Cloudflare ingress and provider design
- [docs/CLAUDE_CODE.md](docs/CLAUDE_CODE.md): connecting Claude Code
- [CLAUDE.md](CLAUDE.md): instructions for AI engineers working in this repo

## Security

This repository is public. It contains no credentials and never will. Credentials
live on the host in permissioned files and are documented by location only
([docs/SECURITY.md](docs/SECURITY.md) §3). If you believe you have found a secret or
a vulnerability here, do not open a public issue. Contact the repository owner
directly through GitHub.
