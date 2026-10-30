import { createHash, randomBytes } from 'node:crypto';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import type { Config } from '../config.js';

// openid/email: 認可したアカウントの確認用。
// drive: 手動作成済みの地域フォルダーの列挙と、そこへの写真保存に必要。
// drive.fileはアプリが作成・Pickerで開いたファイルにしか触れないため、既存フォルダーへの保存と「新フォルダーを作るだけでURLが有効」を両立できない。
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
export const OAUTH_SCOPES = ['openid', 'email', DRIVE_SCOPE] as const;

export interface TokenExchangeResult {
  refreshToken: string | null;
  email: string | null;
  emailVerified: boolean;
  /** 実際に付与されたスコープ（同意画面で個別に外されうる）。 */
  scopes: string[];
}

export interface GoogleOAuth {
  buildAuthUrl(params: { state: string; codeChallenge: string }): string;
  exchangeCode(params: { code: string; codeVerifier: string }): Promise<TokenExchangeResult>;
  /** リフレッシュトークンから自動更新されるクライアントを返す。 */
  clientFor(refreshToken: string): OAuth2Client;
  /** 保存済みトークンに実際に付与されているスコープ。取得できなければ空配列。 */
  grantedScopes(refreshToken: string): Promise<string[]>;
}

export class GoogleOAuthClient implements GoogleOAuth {
  private cached: { token: string; client: OAuth2Client } | null = null;

  constructor(private readonly config: Config) {}

  private newClient() {
    return new OAuth2Client({
      clientId: this.config.googleClientId,
      clientSecret: this.config.googleClientSecret,
      redirectUri: this.config.oauthRedirectUri,
    });
  }

  buildAuthUrl({ state, codeChallenge }: { state: string; codeChallenge: string }): string {
    return this.newClient().generateAuthUrl({
      access_type: 'offline',
      // 既存の付与があってもリフレッシュトークンを確実に再発行させる。
      prompt: 'consent',
      scope: [...OAUTH_SCOPES],
      state,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      include_granted_scopes: false,
      login_hint: this.config.driveOwnerEmail,
    });
  }

  async exchangeCode({ code, codeVerifier }: { code: string; codeVerifier: string }): Promise<TokenExchangeResult> {
    const client = this.newClient();
    const { tokens } = await client.getToken({ code, codeVerifier });
    let email: string | null = null;
    let emailVerified = false;
    if (tokens.id_token) {
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: this.config.googleClientId });
      const payload = ticket.getPayload();
      email = payload?.email?.toLowerCase() ?? null;
      emailVerified = payload?.email_verified === true;
    }
    return {
      refreshToken: tokens.refresh_token ?? null,
      email,
      emailVerified,
      scopes: tokens.scope?.split(' ').filter(Boolean) ?? [],
    };
  }

  async grantedScopes(refreshToken: string): Promise<string[]> {
    try {
      const client = this.clientFor(refreshToken);
      const { token } = await client.getAccessToken();
      if (!token) return [];
      return (await client.getTokenInfo(token)).scopes;
    } catch {
      return [];
    }
  }

  clientFor(refreshToken: string): OAuth2Client {
    if (this.cached?.token !== refreshToken) {
      const client = this.newClient();
      client.setCredentials({ refresh_token: refreshToken });
      this.cached = { token: refreshToken, client };
    }
    return this.cached.client;
  }
}

const b64url = (buf: Buffer) => buf.toString('base64url');

export function generatePkce() {
  const codeVerifier = b64url(randomBytes(32));
  const codeChallenge = b64url(createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

export const generateState = () => b64url(randomBytes(32));
