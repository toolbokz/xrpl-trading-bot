# Bot API Security Model (Implemented)

This document describes the security model that is currently implemented for `/api/bot/*` endpoints.

## Implementation Status

| Control | Status | Notes |
| --- | --- | --- |
| Localhost bind (`127.0.0.1`) | Implemented | Enforced by `server.js` when running the dashboard server. |
| Local request validation | Implemented | Enforced by `withLocalApi` using `socket.remoteAddress` and proxy-header checks. |
| Optional shared token (`LOCAL_API_TOKEN`) | Implemented | If set, every protected request must include the token. |
| HMAC request signing (`X-API-KEY`, `X-SIGNATURE`, etc.) | Not implemented | No runtime validation path exists for this model. |
| RBAC role/permission checks | Not implemented | No runtime role mapping/enforcement exists for API routes. |

## Request Security Flow

1. The dashboard server binds to `127.0.0.1` by default (`server.js`).
2. Protected API routes use `withLocalApi` middleware.
3. `withLocalApi` rejects non-local connections.
4. `withLocalApi` rejects proxied requests in non-dev mode if forwarding headers indicate a non-local source.
5. If `LOCAL_API_TOKEN` is configured, `withLocalApi` requires a matching token.

## Authentication Contract (Current)

### Default mode

- No API token is required when `LOCAL_API_TOKEN` is unset.
- Access is still restricted to localhost by network binding and middleware checks.

### Optional token mode

If `LOCAL_API_TOKEN` is set, callers must include one of:

- `X-Local-Api-Token: <token>`
- `Authorization: Bearer <token>`

### cURL examples

Without token (localhost only):

```bash
curl -X POST http://127.0.0.1:3000/api/bot/run
```

With token (localhost only):

```bash
curl -X POST http://127.0.0.1:3000/api/bot/run \
  -H "X-Local-Api-Token: $LOCAL_API_TOKEN"
```

Bearer variant:

```bash
curl -X POST http://127.0.0.1:3000/api/bot/run \
  -H "Authorization: Bearer $LOCAL_API_TOKEN"
```

## Environment Configuration

Use `.env.example` / `.env.example.development` as references.

```bash
# Optional, but strongly recommended for local multi-user hosts
LOCAL_API_TOKEN=replace-with-long-random-token

# Dev-only behavior: permits localhost proxy-header artifacts from Next dev server
BOT_API_DEV_MODE=true

# Dangerous override: allows remote bind/deployment paths
# Keep unset in normal operation.
# BOT_ALLOW_REMOTE=true
```

## Not Implemented (Important)

- HMAC API signing is not implemented.
- RBAC permission enforcement is not implemented.
- Do not configure operators/clients assuming `BOT_API_KEYS`, `X-SIGNATURE`, or role-based endpoint permissions are active.

## Operational Security

If remote access is required, do not expose bot endpoints directly to the public internet.

Recommended patterns:

1. SSH tunnel to localhost-bound service (`ssh -L 3000:127.0.0.1:3000 host`).
2. Private VPN with host firewall rules restricting trusted peers.
3. Reverse proxy with strong authentication (OIDC/mTLS), TLS, and explicit IP allowlists.

Public exposure warning:

- Exposing `/api/bot/*` publicly is unsafe unless you add external auth, transport security, and network controls.
- Localhost bind alone is not a complete security model once remote publishing is introduced.

## Threat Model Summary

| Threat / Scenario | Localhost bind helps? | Notes |
| --- | --- | --- |
| Internet-wide scans and unsolicited remote requests | Yes | Service is not reachable externally when bound to `127.0.0.1`. |
| Misconfigured public DNS/LB to bot API | Partially | Binding helps, but `BOT_ALLOW_REMOTE=true` or external proxying can bypass assumptions. |
| Unauthorized process/user already on the same host | No | Local callers can still reach localhost endpoints; use `LOCAL_API_TOKEN` and OS hardening. |
| Stolen `LOCAL_API_TOKEN` with local host access | No | Token protects only if attacker lacks local channel and cannot intercept local calls. |
| Compromised workstation/browser session | No | Endpoint hardening does not replace host security, patching, and credential hygiene. |

## API Error Responses (Current)

| Status | Error | Meaning |
| --- | --- | --- |
| 401 | `Unauthorized` | `LOCAL_API_TOKEN` missing/invalid when token mode is enabled. |
| 403 | `Remote access denied` | Request source is not localhost. |
| 403 | `Proxied requests not allowed` | Proxy headers indicate non-local forwarding in non-dev mode. |
| 405 | `Method not allowed` | Route does not permit the HTTP method. |
| 500 | `<handler message>` | Unhandled exception in route handler. |

## Source of Truth

- `server.js`
- `src/ui/lib/localApi/withLocalApi.ts`
- `.env.example`
- `.env.example.development`
