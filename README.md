# vs-code-extension

Two modules demonstrating Entra ID (Azure AD) authentication between a VS Code
extension and a Python backend, using the On-Behalf-Of style flow.

## [`client/`](client) — VS Code extension

Uses `@azure/msal-node` to sign the user in interactively using a VS Code URI
callback (`vscode://.../auth-callback`). The
**client** Entra ID app requests a delegated scope **exposed by the server**
Entra ID app (`api://<server-app-id>/access_as_user`). The resulting access
token (audience = server app) is sent to the backend as a bearer token.

## [`server/`](server) — Python backend

A FastAPI service that validates the incoming access token against the public
signing keys from `login.microsoftonline.com`, checking the **signature**,
**expiry**, **audience** and **app role** (`roles` claim). With the server
client secret it can then run the On-Behalf-Of flow to call downstream APIs.

See each module's README for setup and Entra ID app registration details.
