import * as vscode from 'vscode';
import {
  PublicClientApplication,
  Configuration,
  AuthenticationResult,
  AccountInfo,
  LogLevel,
} from '@azure/msal-node';

/**
 * Wraps an MSAL public client application for a VS Code extension.
 *
 * The CLIENT Entra ID app registration (a "public client") is used to sign the
 * user in interactively (an MSAL pop-up / system browser window). The user
 * consents to a delegated scope that is *exposed by the SERVER Entra ID app*
 * (for example `api://<server-app-id>/access_as_user`).
 *
 * The resulting access token has the SERVER app as its audience, so the Python
 * backend can validate it and (optionally) run the On-Behalf-Of flow to call
 * further downstream APIs.
 */
export class AuthService {
  private pca: PublicClientApplication | undefined;
  private account: AccountInfo | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private get config() {
    const cfg = vscode.workspace.getConfiguration('azureObo');
    const tenantId = (cfg.get<string>('tenantId') || 'common').trim();
    const clientId = (cfg.get<string>('clientId') || '').trim();
    const serverScope = (cfg.get<string>('serverScope') || '').trim();
    return { tenantId, clientId, serverScope };
  }

  private getClient(): PublicClientApplication {
    const { tenantId, clientId } = this.config;
    if (!clientId) {
      throw new Error(
        'azureObo.clientId is not configured. Set the CLIENT Entra ID app id in settings.'
      );
    }

    if (!this.pca) {
      const msalConfig: Configuration = {
        auth: {
          clientId,
          authority: `https://login.microsoftonline.com/${tenantId}`,
        },
        system: {
          loggerOptions: {
            loggerCallback(_level, message) {
              console.log(`[MSAL] ${message}`);
            },
            piiLoggingEnabled: false,
            logLevel: LogLevel.Warning,
          },
        },
      };
      this.pca = new PublicClientApplication(msalConfig);
    }
    return this.pca;
  }

  private get scopes(): string[] {
    const { serverScope } = this.config;
    if (!serverScope) {
      throw new Error(
        'azureObo.serverScope is not configured. Set the SERVER app delegated scope, e.g. api://<server-app-id>/access_as_user.'
      );
    }
    return [serverScope];
  }

  /**
   * Interactive sign-in. Opens the system browser so the user can authenticate
   * with MSAL and consent to the server app scope.
   */
  public async signIn(): Promise<AccountInfo> {
    const pca = this.getClient();
    const result = await pca.acquireTokenInteractive({
      scopes: this.scopes,
      openBrowser: async (url: string) => {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      },
      successTemplate:
        '<html><body><h2>Signed in. You can close this tab and return to VS Code.</h2></body></html>',
      errorTemplate:
        '<html><body><h2>Sign-in failed. Please return to VS Code and try again.</h2></body></html>',
    });

    this.account = result.account ?? undefined;
    return this.requireAccount();
  }

  public async signOut(): Promise<void> {
    const pca = this.pca;
    if (pca && this.account) {
      try {
        await pca.getTokenCache().removeAccount(this.account);
      } catch (err) {
        console.warn('Failed to remove account from cache', err);
      }
    }
    this.account = undefined;
  }

  public isSignedIn(): boolean {
    return this.account !== undefined;
  }

  private requireAccount(): AccountInfo {
    if (!this.account) {
      throw new Error('Not signed in.');
    }
    return this.account;
  }

  /**
   * Returns a valid access token for the server app scope, silently refreshing
   * it when possible and falling back to interactive sign-in otherwise.
   */
  public async getAccessToken(): Promise<string> {
    const pca = this.getClient();

    if (this.account) {
      try {
        const silent: AuthenticationResult = await pca.acquireTokenSilent({
          account: this.account,
          scopes: this.scopes,
        });
        if (silent.accessToken) {
          return silent.accessToken;
        }
      } catch (err) {
        console.warn('Silent token acquisition failed, falling back to interactive.', err);
      }
    }

    const interactive = await this.signIn();
    this.account = interactive;
    const result = await pca.acquireTokenSilent({
      account: this.requireAccount(),
      scopes: this.scopes,
    });
    return result.accessToken;
  }
}
