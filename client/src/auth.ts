import * as vscode from 'vscode';
import {
  PublicClientApplication,
  Configuration,
  AuthenticationResult,
  AccountInfo,
  LogLevel,
  AuthorizationUrlRequest,
  AuthorizationCodeRequest,
  CryptoProvider,
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
export class AuthService implements vscode.UriHandler {
  private pca: PublicClientApplication | undefined;
  private account: AccountInfo | undefined;
  private pendingAuth:
    | {
        state: string;
        resolve: (uri: vscode.Uri) => void;
        reject: (err: Error) => void;
        timer: NodeJS.Timeout;
      }
    | undefined;
  private readonly cryptoProvider = new CryptoProvider();

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
   * Interactive sign-in using auth-code + PKCE with a VS Code URI callback.
   */
  public async signIn(): Promise<AccountInfo> {
    const pca = this.getClient();
    const redirectUri = this.redirectUri;
    const pkceCodes = await this.cryptoProvider.generatePkceCodes();
    const state = this.cryptoProvider.createNewGuid();

    const authCodePromise = this.waitForAuthCallback(state);
    const authUrlRequest: AuthorizationUrlRequest = {
      authority: `https://login.microsoftonline.com/${this.config.tenantId}`,
      scopes: this.scopes,
      redirectUri,
      codeChallenge: pkceCodes.challenge,
      codeChallengeMethod: 'S256',
      state,
    };

    const authUrl = await pca.getAuthCodeUrl(authUrlRequest);
    const opened = await vscode.env.openExternal(vscode.Uri.parse(authUrl));
    if (!opened) {
      this.clearPendingAuth(new Error('Failed to open browser for sign-in.'));
      throw new Error('Failed to open browser for sign-in.');
    }

    const callbackUri = await authCodePromise;
    const query = new URLSearchParams(callbackUri.query);
    const error = query.get('error');
    const errorDescription = query.get('error_description');
    if (error) {
      throw new Error(
        `Sign-in failed: ${errorDescription ? `${error}: ${errorDescription}` : error}`
      );
    }

    const code = query.get('code');
    if (!code) {
      throw new Error('Sign-in failed: callback did not include an authorization code.');
    }

    const tokenRequest: AuthorizationCodeRequest = {
      authority: `https://login.microsoftonline.com/${this.config.tenantId}`,
      scopes: this.scopes,
      redirectUri,
      code,
      codeVerifier: pkceCodes.verifier,
    };
    const result = await pca.acquireTokenByCode(tokenRequest);

    this.account = result.account ?? undefined;
    return this.requireAccount();
  }

  public handleUri(uri: vscode.Uri): void {
    const pending = this.pendingAuth;
    if (!pending) {
      return;
    }

    const expectedPath = '/auth-callback';
    if (uri.path !== expectedPath) {
      return;
    }

    const query = new URLSearchParams(uri.query);
    const state = query.get('state');
    if (!state || state !== pending.state) {
      this.clearPendingAuth(new Error('Sign-in failed: invalid callback state.'));
      return;
    }

    this.clearPendingAuth();
    pending.resolve(uri);
  }

  private waitForAuthCallback(expectedState: string): Promise<vscode.Uri> {
    if (this.pendingAuth) {
      throw new Error('A sign-in flow is already in progress.');
    }

    return new Promise<vscode.Uri>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pendingAuth;
        if (!pending || pending.state !== expectedState) {
          return;
        }
        clearTimeout(pending.timer);
        this.pendingAuth = undefined;
        pending.reject(new Error('Sign-in timed out waiting for callback.'));
      }, 5 * 60 * 1000);

      this.pendingAuth = {
        state: expectedState,
        resolve,
        reject,
        timer,
      };
    });
  }

  private clearPendingAuth(err?: Error): void {
    const pending = this.pendingAuth;
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingAuth = undefined;
    if (err) {
      pending.reject(err);
    }
  }

  private get redirectUri(): string {
    const extensionId = this.context.extension.id;
    return `${vscode.env.uriScheme}://${extensionId}/auth-callback`;
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
