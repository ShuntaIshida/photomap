import type { Config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { errors } from '../src/errors.js';
import type { AuthService, AuthUser } from '../src/services/authService.js';
import { DriveAuthorization } from '../src/services/driveAuthorization.js';
import type { DriveFolder, DriveGateway } from '../src/services/driveGateway.js';
import type { GoogleOAuth, TokenExchangeResult } from '../src/services/googleOAuth.js';
import { RegionService } from '../src/services/regions.js';
import { MemoryOAuthStateStore } from '../src/stores/oauthStateStore.js';
import { MemoryRefreshTokenStore } from '../src/stores/refreshTokenStore.js';

export const config: Config = {
  port: 8080,
  firebaseProjectId: 'test-project',
  googleClientId: 'client-id',
  googleClientSecret: 'client-secret',
  oauthRedirectUri: 'https://api.example.test/oauth/google/callback',
  driveParentFolderId: 'parent-folder-id-12345',
  driveOwnerEmail: 'owner@example.ac.jp',
  refreshTokenSecretName: 'secret',
  adminUids: new Set(),
  corsAllowedOrigins: ['https://shuntaishida.github.io', 'http://localhost:5173'],
};

export const users: Record<string, AuthUser> = {
  'admin-token': { uid: 'admin-uid', admin: true },
  'user-token': { uid: 'user-uid', admin: false },
};

export class FakeAuth implements AuthService {
  admins = new Set(['admin-uid']);
  async verifyIdToken(token: string) {
    const user = users[token];
    if (!user) throw new Error('invalid');
    return user;
  }
  async isAdmin(uid: string) {
    return this.admins.has(uid);
  }
}

export class FakeGoogle implements GoogleOAuth {
  exchange: TokenExchangeResult = { refreshToken: 'refresh-token-value', email: 'owner@example.ac.jp', emailVerified: true };
  lastVerifier: string | null = null;
  buildAuthUrl({ state, codeChallenge }: { state: string; codeChallenge: string }) {
    return `https://accounts.example.test/auth?state=${state}&code_challenge=${codeChallenge}`;
  }
  async exchangeCode({ codeVerifier }: { code: string; codeVerifier: string }) {
    this.lastVerifier = codeVerifier;
    return this.exchange;
  }
  clientFor(): never {
    throw new Error('not used');
  }
}

export class FakeGateway implements DriveGateway {
  folders: DriveFolder[] = [];
  calls = 0;
  constructor(private readonly tokens: MemoryRefreshTokenStore) {}
  async isAuthorized() {
    return (await this.tokens.get()) !== null;
  }
  async listChildFolders() {
    this.calls++;
    if (!(await this.tokens.get())) throw errors.driveNotAuthorized();
    return this.folders;
  }
}

export function build() {
  const tokens = new MemoryRefreshTokenStore();
  const states = new MemoryOAuthStateStore();
  const auth = new FakeAuth();
  const google = new FakeGoogle();
  const gateway = new FakeGateway(tokens);
  const regions = new RegionService(gateway);
  const authorization = new DriveAuthorization({ config, google, states, tokens, isAdmin: (uid) => auth.isAdmin(uid) });
  const app = createApp({ config, auth, authorization, gateway, regions });
  return { app, tokens, states, auth, google, gateway, regions };
}
