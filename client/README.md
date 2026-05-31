# Azure OBO Client (VS Code extension)

Signs the user in with MSAL (`@azure/msal-node`) and calls the Python backend
using an access token issued for the **server** Entra ID app.

## Flow

1. The user runs **Azure OBO: Sign In**. The extension opens the system browser
   for an interactive MSAL login using the **client** app registration.
2. The user consents to a delegated scope **exposed by the server app**
   (`api://<server-app-id>/access_as_user`). The resulting access token has the
   server app as its audience.
3. **Azure OBO: Call Python Server** sends that token as a bearer token to the
   backend, which validates the signature, expiry and app role.

## Configuration (VS Code settings)

| Setting | Description |
| --- | --- |
| `azureObo.tenantId` | Tenant id, or `common`/`organizations`. |
| `azureObo.clientId` | Application (client) id of the **client** public app. |
| `azureObo.serverScope` | Delegated scope of the **server** app, e.g. `api://<server-app-id>/access_as_user`. |
| `azureObo.serverUrl` | Base URL of the Python backend (default `http://localhost:8000`). |

## Develop

```bash
npm install
npm run compile
npm install -g @vscode/vsce  
vsce package 
code --install-extension azure-obo-client-0.0.1.vsix
```

Press `F5` in VS Code to launch the Extension Development Host, then run the
commands from the Command Palette.

## Entra ID app setup (summary)

- **Server app**: expose an API with a scope `access_as_user` and define an app
  role (e.g. `Api.Access`).
- **Client app**: register as a public client (allow public client flows) and
  add a delegated permission to the server app's `access_as_user` scope.
