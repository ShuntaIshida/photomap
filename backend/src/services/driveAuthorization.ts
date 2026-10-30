import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import { log } from '../logger.js';
import type { OAuthStateStore } from '../stores/oauthStateStore.js';
import type { RefreshTokenStore } from '../stores/refreshTokenStore.js';
import { DRIVE_SCOPE, generatePkce, generateState, type GoogleOAuth } from './googleOAuth.js';

const STATE_TTL_MS = 10 * 60 * 1000;

export interface DriveAuthorizationDeps {
  config: Config;
  google: GoogleOAuth;
  states: OAuthStateStore;
  tokens: RefreshTokenStore;
  /** コールバック時点でも開始ユーザーが管理者であることを再確認する。 */
  isAdmin: (uid: string) => Promise<boolean>;
}

export class DriveAuthorization {
  constructor(private readonly deps: DriveAuthorizationDeps) {}

  async start(adminUid: string): Promise<string> {
    const state = generateState();
    const { codeVerifier, codeChallenge } = generatePkce();
    await this.deps.states.put(state, { adminUid, codeVerifier, expiresAt: Date.now() + STATE_TTL_MS });
    return this.deps.google.buildAuthUrl({ state, codeChallenge });
  }

  async complete(params: { code: string; state: string }): Promise<{ email: string }> {
    // stateは1回限り。未登録・期限切れ・再利用はすべて同じエラーにする。
    const record = await this.deps.states.consume(params.state);
    if (!record) throw new AppError(400, 'invalid_state', 'Authorization request is invalid or expired');

    if (!(await this.deps.isAdmin(record.adminUid))) {
      log('WARNING', 'oauth callback rejected: initiating user is no longer admin', { uid: record.adminUid });
      throw new AppError(403, 'forbidden', 'Administrator privileges required');
    }

    let result;
    try {
      result = await this.deps.google.exchangeCode({ code: params.code, codeVerifier: record.codeVerifier });
    } catch {
      throw new AppError(400, 'code_exchange_failed', 'Failed to exchange the authorization code');
    }

    // 認可したアカウントが想定のDrive所有者であることを確認する。
    if (!result.email || !result.emailVerified || result.email !== this.deps.config.driveOwnerEmail) {
      log('WARNING', 'oauth callback rejected: unexpected Google account');
      throw new AppError(403, 'unexpected_account', 'Authorized Google account is not the configured Drive owner');
    }
    if (!result.refreshToken) {
      throw new AppError(400, 'no_refresh_token', 'Google did not return a refresh token; revoke access and retry');
    }
    // 同意画面でDriveを個別に外された場合は保存せず、誤った「認可済み」状態を作らない。
    if (!result.scopes.includes(DRIVE_SCOPE)) {
      throw new AppError(400, 'insufficient_scope', 'The Google Drive permission was not granted; re-authorize and allow it');
    }

    await this.deps.tokens.save(result.refreshToken);
    log('INFO', 'drive authorization stored', { uid: record.adminUid });
    return { email: result.email };
  }
}
