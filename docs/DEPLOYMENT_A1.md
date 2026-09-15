# Deployment on the Oracle A1 VM

The A1 VM is the persistent host for the TN-MCPs gateway and provider MCP processes.
It already runs production Telos Nexus and JARVIS services. Every operation here is
additive and restricted to the dedicated `tn-mcp-*` units.

Status: planning only. No deployment action has run; §1 is the read-only audit from
2026-09-15. The `deploy/` tree is created in Phase 6.

## 1. Host audit (2026-09-15, read-only)

| Item | Finding | Implication |
| --- | --- | --- |
| OS | Ubuntu 20.04.6 LTS, kernel 5.15 | Standard support ended 2025-05; owner Q7 chooses ESM or upgrade |
| Architecture | aarch64, 4 vCPU | linux-arm64 toolchain required; verified for Phase 1 tools |
| Memory | 23 GiB, ~13 GiB available, 8 GiB swap fully used | Per-process memory limits and soak testing required |
| cgroups | v1 | Verify `MemoryMax=` enforcement (S6), otherwise use compatible limit |
| Disk | 194 GB, 84 GB free | Alert at 80% for `/var/lib/tn-mcps` |
| Time | NTP synchronized, UTC | Preflight checks because JWT, approval, and audit ordering depend on it |
| Runtime | Node 24.20.0, systemd 245 | Supported runtime; systemd predates `LoadCredential=` |
| Docker | absent; LXD present | Native systemd; no Docker introduced |
| cloudflared | 2026.9.1 in a user home | Install official system binary for the dedicated TN-MCPs unit |
| Existing tunnel | user-level `cloudflared.service` for another Telos service | Never touch it; a same-named system unit would be confusing and collide with `cloudflared service install` |
| Sudo | AI CLIs run as passwordless-sudo `ubuntu` | Residual B13; Q11 required before writes |
| Firewall | inbound allow 22/443/established/loopback/LXD, reject rest | Add no inbound rule |
| Existing services | JARVIS, jobs API/tunnel/Litestream, local LLMs | Never restart or reconfigure |
| Ports | 8790 and 8701–8704 free | Central port map chosen; preflight rechecks |

## 2. Filesystem, identities, and ports

```text
/opt/tn-mcps/
├── repo.git/                         anonymous bare mirror
├── releases/<git-sha>/               immutable checkout + build
└── current -> releases/<git-sha>

/etc/tn-mcps/                         root:root 0755; no secrets at this level
├── gateway/                          root:tnmcp-gateway 0750
│   └── gateway.env                   root:tnmcp-gateway 0640
├── cloudflare/                       root:tnmcp-cloudflare 0750
│   ├── cloudflare.env                root:tnmcp-cloudflare 0640
│   └── provider/audit secret files   root:tnmcp-cloudflare 0640
├── github/                           root:tnmcp-github 0750
│   └── github.env + secret files     root:tnmcp-github 0640
├── oracle/                           root:tnmcp-oracle 0750
│   └── oracle.env + secret files     root:tnmcp-oracle 0640
├── telos/                            root:tnmcp-telos 0750
│   └── telos.env + secret files      root:tnmcp-telos 0640
└── tunnel/                           root:tnmcp-tunnel 0750
    ├── tunnel.env                    root:tnmcp-tunnel 0640
    └── tunnel.token                  root:tnmcp-tunnel 0640

/run/tn-mcps/gateway.sock             approvals API; gateway-owned; peer UID checked
/var/lib/tn-mcps/approvals.sqlite     tnmcp-gateway; sole writer
/var/lib/tn-mcps/audit/<process>/     each process writes only its own chain
```

| Process | Port | Unit/user |
| --- | --- | --- |
| gateway | 127.0.0.1:8790 | `tn-mcp-gateway.service` / `tnmcp-gateway` |
| Cloudflare MCP | 127.0.0.1:8701 | `tn-mcp-cloudflare.service` / `tnmcp-cloudflare` |
| GitHub MCP | 127.0.0.1:8702 | `tn-mcp-github.service` / `tnmcp-github` |
| Oracle MCP | 127.0.0.1:8703 | `tn-mcp-oracle.service` / `tnmcp-oracle` |
| Telos-control MCP | 127.0.0.1:8704 | `tn-mcp-telos.service` / `tnmcp-telos` |
| tunnel | n/a | `tn-mcp-tunnel.service` / `tnmcp-tunnel` |

All users are non-login, non-sudo, and outside `docker`/`lxd`. Provider users cannot
traverse another provider's config directory. The gateway has no provider credential.
Configuration values and `*_FILE` paths live in each `<process>.env`; secret values are
only in the sibling files. `packages/config` is authoritative for the port map.

## 3. systemd drafts (Phase 6)

Gateway:

```ini
# tn-mcp-gateway.service
[Unit]
Description=Telos Nexus MCP thin gateway
After=network-online.target time-sync.target
Wants=network-online.target

[Service]
Type=simple
User=tnmcp-gateway
Group=tnmcp-gateway
WorkingDirectory=/opt/tn-mcps/current
EnvironmentFile=/etc/tn-mcps/gateway/gateway.env
ExecStart=/usr/bin/node gateway/dist/main.js
Restart=on-failure
RestartSec=5
MemoryMax=512M
RuntimeDirectory=tn-mcps
RuntimeDirectoryMode=0750
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
ReadWritePaths=/run/tn-mcps /var/lib/tn-mcps/approvals.sqlite /var/lib/tn-mcps/audit/gateway
ReadOnlyPaths=/etc/tn-mcps/gateway

[Install]
WantedBy=multi-user.target
```

Per-MCP example (the GitHub/Oracle/Telos units use their own user, config, executable,
audit directory, and fixed central port):

```ini
# tn-mcp-cloudflare.service
[Unit]
Description=Telos Nexus Cloudflare MCP server
After=network-online.target tn-mcp-gateway.service
Wants=network-online.target

[Service]
Type=simple
User=tnmcp-cloudflare
Group=tnmcp-cloudflare
WorkingDirectory=/opt/tn-mcps/current
EnvironmentFile=/etc/tn-mcps/cloudflare/cloudflare.env
ExecStart=/usr/bin/node mcps/cloudflare/dist/main.js
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
ReadWritePaths=/run/tn-mcps /var/lib/tn-mcps/audit/cloudflare
ReadOnlyPaths=/etc/tn-mcps/cloudflare

[Install]
WantedBy=multi-user.target
```

Tunnel:

```ini
# tn-mcp-tunnel.service
[Unit]
Description=Dedicated Cloudflare Tunnel for TN-MCPs
After=network-online.target tn-mcp-gateway.service
Wants=network-online.target

[Service]
Type=simple
User=tnmcp-tunnel
Group=tnmcp-tunnel
EnvironmentFile=/etc/tn-mcps/tunnel/tunnel.env
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

Do not add `IPAddressDeny=`: it restricts outbound sockets too and would block JWKS
and provider calls. Loopback-only listening is enforced by typed config/tests and the
preflight `ss` check for every configured process (B6).

## 4. Preflight, deploy, verification, rollback

There is no inbound deploy hook, no self-hosted runner, and no reuse of the owner's
GitHub CLI login. With explicit approval for each production deploy:

```bash
deploy/scripts/deploy.sh <full-40-character-sha>
```

The scripts accept only unit names matching `tn-mcp-*` (B11). Every step must pass:

1. Preflight verifies synchronized time, production Access auth, every expected
   directory/file owner and mode, central loopback ports free or owned by the expected
   service, Unix-socket location, and exact unit allowlist.
2. An unauthenticated public GitHub REST read proves a successful push-triggered `CI`
   run on `main` for the exact SHA. No GitHub credential is used.
3. The anonymous bare mirror verifies the SHA is an ancestor of `origin/main`; a new
   worktree's HEAD must equal the requested SHA.
4. The exact release bytes pass frozen install, `pnpm run check`, and build on host.
5. Approvals/audit schema compatibility is checked; migrations are expand-only.
6. `current.new` is atomically renamed to `current`. Pending approvals from another
   gateway release expire. Only installed TN-MCPs units are restarted, providers first
   and gateway last.
7. Verify each enabled backend locally, gateway `GET http://127.0.0.1:8790/healthz`,
   an authenticated MCP handshake through each public path, wrong-audience denial,
   and that unauthenticated public calls are rejected by Access.
8. On failure, rollback atomically to the previous compatible release, restart only
   the same TN-MCPs units, and repeat local/edge checks. Keep the last five releases.

Phase 6 explicitly tests `systemctl kill` on gateway and Cloudflare MCP and confirms
automatic restart. The owner schedules one reboot-survival test and confirms enabled
processes, tunnel, health, auth, and audit continuity recover. Rollback is rehearsed
before acceptance. Phase 8 evaluates a provenance-attested CI artifact (S10) but the
on-host full gate remains the baseline.

## 5. Tunnel and exposure

The dedicated remotely managed tunnel `tn-mcps` publishes:

- Phase 6: `mcp.telosnexus.cloud` → `http://127.0.0.1:8790`;
- Phase 8: `approve.telosnexus.cloud` → the same gateway;
- mandatory catch-all 404.

The gateway routes provider paths; no tunnel route reaches backend ports. The unit is
deliberately `tn-mcp-tunnel.service`, not the generic name, because the VM already has
a user-level unit with the generic name for another Telos service and a same-named
system unit would be confusing and collide with `cloudflared service install`.
Cloudflared needs outbound 7844 TCP/UDP; no inbound firewall or Oracle security-list
rule is added.

## 6. Backups and must-not-happen rules

Phase 8 ships each audit chain off-box within 15 minutes using an object-write-only,
bucket-scoped credential. The approval DB is snapshotted daily. Restore uses a separate
read-only credential held by the owner off-VM, into a temporary directory, followed by
chain verification. The restore drill must pass before Phase 9.

- Never modify, restart, disable, or reuse existing JARVIS, jobs API, user tunnel,
  Litestream, local-model, or other Telos services.
- Never create an inbound rule, install Docker, bind outside loopback, run development
  auth on the host, or deploy without owner approval.
- Never let gateway read provider tokens or one provider user read another's files.
- Never roll back across an unsupported live schema.
