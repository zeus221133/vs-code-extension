# Azure OBO Python Backend

Validates the access tokens that the VS Code extension obtains for this
(SERVER) Entra ID app. Validation is done with the public signing keys
published by `login.microsoftonline.com`.

## What is validated

For every protected request the bearer token is checked for:

1. **Signature** — RS256, key matched by `kid` against the tenant JWKS endpoint
   (discovered from the OpenID configuration).
2. **Expiry / not-before** (`exp`, `iat`).
3. **Audience** (`aud`) — must be this server app (`<server-app-id>` or
   `api://<server-app-id>`).
4. **Issuer** (`iss`) — must match the authority (tenant-aware for `common`).
5. **App role** (`roles`) — optional; configure `AAD_REQUIRED_APP_ROLES`.

## Configuration

Copy `.env.example` and export the variables (or use your process manager):

| Variable | Description |
| --- | --- |
| `AAD_TENANT_ID` | Tenant id (GUID) or `common`/`organizations`. |
| `AAD_SERVER_CLIENT_ID` | Application (client) id of the **server** app. |
| `AAD_REQUIRED_APP_ROLES` | Comma-separated roles; any one is accepted. Empty = no role check. |
| `AAD_SERVER_CLIENT_SECRET` | Only needed for the On-Behalf-Of flow to downstream APIs. |

## Run

```bash
pip install -r requirements.txt
export AAD_TENANT_ID=<your-tenant-id>
export AAD_SERVER_CLIENT_ID=<server-app-client-id>
export AAD_REQUIRED_APP_ROLES=Api.Access
uvicorn app:app --host 0.0.0.0 --port 8000
```

Then call `GET /api/me` with `Authorization: ******

## On-Behalf-Of (downstream calls)

The token received here is addressed to the server app. To call a *further*
downstream API as the same user, the server can exchange this token using the
OBO grant (`urn:ietf:params:oauth:grant-type:jwt-bearer`) with
`AAD_SERVER_CLIENT_SECRET`. Token validation above is the prerequisite for that
exchange.
