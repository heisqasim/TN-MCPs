# Deployment on the Oracle A1 VM

The A1 VM is the persistent host for the TN MCP gateway. It **already runs production
Telos Nexus and Jarvis services**. Every step here is designed to add TN-MCPs
alongside them without touching them.

Status: planning document. Nothing in this file has been executed except the read-only
audit in §1. `deploy/` is created in Phase 6.

## 1. Host audit (2026-09-15, read-only)

| Item | Finding | Implication |
| --- | --- | --- |
| OS | Ubuntu 20.04.6 LTS, kernel 5.15 (oracle) | **Standard support ended 2025-05.** Ubuntu Pro ESM is available but not attached. Owner decision Q7. Not blocking for Node 24 (glibc 2.31) |
| Arch | aarch64 (Ampere Neoverse-N1), 4 vCPU | All dependencies need linux-arm64 builds (verified for TypeScript 7, Biome 2.5, Node 24) |
| Memory | 23 GiB RAM, ~13 GiB available (mostly cache), **8 GiB swap 100% used** | Local LLM services dominate RAM. The gateway gets `MemoryMax=512M` and must stay lean |
| cgroups | v1 (`/sys/fs/cgroup` is tmpfs) | Confirm `MemoryMax=` is enforced (MASTER_PLAN S6) or use `MemoryLimit=` |
| Disk | 194 GB, 84 GB free (57% used) | Fine. Alert at 80% on `/var/lib/tn-mcps` (Phase 8) |
| Time | NTP active, clock synchronized, UTC | JWT expiry, approval expiry, and audit order depend on it; `preflight.sh` checks it |
| Node / npm | v24.20.0 (Active LTS) / 11.19.0, system-wide | Target runtime |
| pnpm | 12.4.1 (installed during bootstrap, user prefix) | Pinned via `packageManager`. Phase 6 installs it where the deploy user can reach it |
| Docker | **not installed** (LXD is present) | Native systemd deployment (ARCHITECTURE §10) |
| git / gh | 2.25.1 / 2.100.0 (logged in as the owner) | `deploy.sh` does **not** use the `gh` login (§4) |
| cloudflared | 2026.9.1 in a user's home directory | Phase 6 installs the official package system-wide at `/usr/local/bin/cloudflared` |
| Claude Code | 2.1.272 | v2 MCP runtime, 2026-07-28 capable |
| systemd | 245 | **Predates `LoadCredential=`.** Secrets are read by path |
| sudo | **`ubuntu` has passwordless sudo**, and AI agent CLIs run as `ubuntu` | Residual risk B13. Owner decision Q11 |
| Reverse proxies | none | Not needed. cloudflared talks straight to the loopback port |
| Firewall | iptables INPUT: allow 22, 443, established, lo, LXD bridge; reject the rest. ufw inactive. Oracle VCN security lists not inspected | TN-MCPs adds **no** inbound rule |
| Existing tunnel | one user-level `cloudflared.service` (another Telos service), remotely managed, token read from a file | **Do not touch.** TN-MCPs uses its own tunnel, users, unit names, and binary path |
| `/etc/cloudflared` | does not exist | TN-MCPs doesn't create it; it uses `/etc/tn-mcps/` |
| Existing services | Jarvis stack (system units), Telos jobs API + tunnel + Litestream (user units), local LLM servers | Out of scope. Never restart or reconfigure |
| Loopback ports in use | 5432, 8000, 8008, 8080–8082, 8097, 8400, 20241 (+ ephemeral agent ports) | Gateway port **8787** was free on 2026-09-15; `preflight.sh` re-checks |

## 2. Layout (Phase 6)

```
/opt/tn-mcps/                          root:root 0755
├── releases/<git-sha>/                 immutable checkout + build of one commit
└── current -> releases/<git-sha>
/etc/tn-mcps/                          root:root 0755   (no secrets directly inside)
├── gateway/                           root:tnmcp 0750
│   ├── gateway.env                    root:tnmcp 0640  non-secret config + *_FILE paths
│   ├── cloudflare-read.token          root:tnmcp 0640
│   ├── cloudflare-read-upstream.token root:tnmcp 0640
│   └── audit-hmac-<keyId>.key         root:tnmcp 0640
└── tunnel/                            root:tnmcp-tunnel 0750
    └── tunnel.token                   root:tnmcp-tunnel 0640
/var/lib/tn-mcps/                      tnmcp:tnmcp 0750 (audit/, approvals.sqlite)
```

System users: `tnmcp` runs the gateway and `tnmcp-tunnel` runs cloudflared. Neither has
a login shell, and neither is in `sudo`, `docker`, or `lxd`. Neither can read the
other's secrets. `preflight.sh` checks every owner and mode above and refuses to deploy
on any mismatch.

## 3. systemd units (drafts, committed under `deploy/systemd/` in Phase 6)

```ini
# tn-mcps-gateway.service
[Unit]
Description=Telos Nexus MCP gateway (loopback only)
After=network-online.target time-sync.target
Wants=network-online.target

[Service]
Type=simple
User=tnmcp
Group=tnmcp
WorkingDirectory=/opt/tn-mcps/current
EnvironmentFile=/etc/tn-mcps/gateway/gateway.env
ExecStart=/usr/bin/node servers/gateway/dist/main.js
Restart=on-failure
RestartSec=5
MemoryMax=512M
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
LockPersonality=yes
ReadWritePaths=/var/lib/tn-mcps
ReadOnlyPaths=/etc/tn-mcps/gateway

[Install]
WantedBy=multi-user.target
```

No `IPAddressDeny=`/`IPAddressAllow=`: they restrict **all** of the unit's sockets,
outbound included, and would block Cloudflare API and JWKS calls. Loopback-only
listening is enforced by the bind address, the config schema, and `preflight.sh`'s `ss`
check (MASTER_PLAN B6).

```ini
# tn-mcps-tunnel.service
[Unit]
Description=Cloudflare Tunnel for TN-MCPs (dedicated; not the existing Telos tunnel)
After=network-online.target tn-mcps-gateway.service
Wants=network-online.target

[Service]
Type=simple
User=tnmcp-tunnel
Group=tnmcp-tunnel
ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate run --token-file /etc/tn-mcps/tunnel/tunnel.token
Restart=on-failure
RestartSec=10
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadOnlyPaths=/etc/tn-mcps/tunnel

[Install]
WantedBy=multi-user.target
```

## 4. Deployment procedure (pull-based, Phase 6)

There is **no inbound deploy hook, no self-hosted runner, and no reuse of the owner's
`gh` login.** CI on GitHub-hosted runners proves a commit. The VM pulls it and proves it
again.

```bash
# on the VM, with explicit owner approval for each production deploy
deploy/scripts/deploy.sh <full-40-char-sha>
```

`deploy.sh` trust chain. Every step must pass, or the deploy stops:

1. **Clock and preflight:** `timedatectl` reports synchronized; `preflight.sh` passes
   (auth mode `access`, ownership/modes, port, unit-name allowlist).
2. **CI proof, unauthenticated public API:**
   `GET https://api.github.com/repos/heisqasim/TN-MCPs/actions/runs?head_sha=<sha>&event=push&branch=main&status=success`.
   At least one run must have `name == "CI"`, `path == ".github/workflows/ci.yml"`,
   `head_sha == <sha>`, `head_branch == "main"`, `event == "push"`, and
   `conclusion == "success"`. The repository is public, so no credential is needed.
3. **Ancestry:** in a dedicated bare mirror (`/opt/tn-mcps/repo.git`, fetched
   anonymously over HTTPS), `git merge-base --is-ancestor <sha> origin/main` must succeed.
4. **Tree identity:** `git worktree add releases/<sha> <sha>`; `git -C releases/<sha>
   rev-parse HEAD` must equal `<sha>` exactly.
5. **Test the exact bytes:** `pnpm install --frozen-lockfile && pnpm run check && pnpm
   build` in the release directory. The artifact that runs is the artifact that was
   tested on this host.
6. **Schema compatibility:** the release declares the approvals/audit schema versions it
   supports. If the live store is newer than the release supports, refuse. (Migrations
   are expand-only, so rolling back to a release that supports the current schema is
   safe.)
7. **Atomic switch:** `ln -s releases/<sha> current.new && mv -T current.new current`,
   then `systemctl restart tn-mcps-gateway`. Pending approvals from the previous release
   expire on startup (they're bound to `gatewayRelease`).
8. **Health:** `curl -fsS http://127.0.0.1:8787/healthz` reports the new version, and an
   unauthenticated public `POST /mcp` still gets Access's 401. On failure:
   `rollback.sh` runs automatically.

`rollback.sh` points `current` at the previous release (same atomic `mv -T`) and
restarts. The last 5 releases are kept. MASTER_PLAN WP 8.6 (S10) evaluates replacing
steps 3–5 with a CI-built artifact verified by build-provenance attestation.

## 5. Must not happen

- No restart, edit, or disable of any existing unit (`jarvis-*`, `tn-jobs-api`, the
  user-level `cloudflared.service`, `litestream`, `alghazaly*`, `tailscaled`). Scripts
  only touch units named `tn-mcps-*` (B11).
- No new inbound iptables rule or Oracle security-list change.
- No Docker installation without a separate, approved decision.
- No binding the gateway to anything but `127.0.0.1`. No `TN_AUTH_MODE=dev` on the host.
- No production deploy without the owner's go-ahead for that deploy.

## 6. Backups (Phase 8)

- Audit records ship off-box within 15 minutes to a dedicated R2 bucket, using an
  object-write-only credential scoped to that bucket. The approvals DB is snapshotted
  daily with `sqlite3 .backup` semantics via `node:sqlite` to the same bucket.
- Restores use a separate read-only credential kept **off the VM** by the owner.
- A restore drill (restore into a temp dir, `tn-mcps audit verify` passes) is required
  before Phase 9 (writes) begins.
