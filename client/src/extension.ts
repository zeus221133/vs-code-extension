import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { AuthService } from './auth';

let authService: AuthService;

export function activate(context: vscode.ExtensionContext): void {
  authService = new AuthService(context);

  context.subscriptions.push(
    vscode.window.registerUriHandler(authService),

    vscode.commands.registerCommand('azureObo.signIn', async () => {
      try {
        const account = await authService.signIn();
        vscode.window.showInformationMessage(
          `Signed in as ${account.username || account.name || 'user'}.`
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Sign-in failed: ${asMessage(err)}`);
      }
    }),

    vscode.commands.registerCommand('azureObo.signOut', async () => {
      await authService.signOut();
      vscode.window.showInformationMessage('Signed out.');
    }),

    vscode.commands.registerCommand('azureObo.callServer', async () => {
      try {
        const token = await authService.getAccessToken();
        const body = await callServer(token);
        vscode.window.showInformationMessage(`Server responded: ${body}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Server call failed: ${asMessage(err)}`);
      }
    })
  );
}

export function deactivate(): void {
  // no-op
}

/**
 * Sends the access token to the Python backend. The token is passed as a
 * standard ******; the server validates its signature, expiry and app
 * role before responding.
 */
function callServer(accessToken: string): Promise<string> {
  const base = (
    vscode.workspace.getConfiguration('azureObo').get<string>('serverUrl') ||
    'http://localhost:8000'
  ).replace(/\/+$/, '');
  const target = new URL(`${base}/api/me`);
  const client = target.protocol === 'https:' ? https : http;
  const authHeader = ['Bearer', accessToken].join(' ');

  return new Promise<string>((resolve, reject) => {
    const req = client.request(
      target,
      {
        method: 'GET',
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            resolve(text);
          } else {
            reject(new Error(`HTTP ${status}: ${text}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
