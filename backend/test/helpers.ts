import { Readable } from 'node:stream';
import { createApp } from '../src/app.js';
import { SharpImageProcessor, type ImageProcessor } from '../src/imaging/imageProcessor.js';
import { PhotoManageService } from '../src/services/photoManage.js';
import { OriginalService } from '../src/services/originals.js';
import type { Config } from '../src/config.js';
import { errors } from '../src/errors.js';
import type { AuthService, AuthUser } from '../src/services/authService.js';
import { DriveAuthorization } from '../src/services/driveAuthorization.js';
import type { DriveFolder, DriveGateway, UploadFileParams } from '../src/services/driveGateway.js';
import { DRIVE_SCOPE, type GoogleOAuth, type TokenExchangeResult } from '../src/services/googleOAuth.js';
import { PhotoUploadService } from '../src/services/photoUpload.js';
import { RegionService } from '../src/services/regions.js';
import { UploadLimiter } from '../src/services/uploadLimiter.js';
import { MemoryOAuthStateStore } from '../src/stores/oauthStateStore.js';
import { MemoryPhotoRepository } from '../src/stores/photoRepository.js';
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
  'admin-token': { uid: 'admin-uid', admin: true, name: 'Admin' },
  'user-token': { uid: 'user-uid', admin: false, name: 'Test User' },
  'user2-token': { uid: 'user2-uid', admin: false, name: 'Second User' },
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
  exchange: TokenExchangeResult = {
    refreshToken: 'refresh-token-value',
    email: 'owner@example.ac.jp',
    emailVerified: true,
    scopes: ['openid', 'email', DRIVE_SCOPE],
  };
  grantedScopesResult: string[] = [DRIVE_SCOPE];
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
  async grantedScopes() {
    return this.grantedScopesResult;
  }
}

/** 書き込み系は未実装のスタブ。必要なテストだけが継承して上書きする。 */
export class StubGateway implements DriveGateway {
  folders: DriveFolder[] = [];
  calls = 0;
  constructor(protected readonly tokens: MemoryRefreshTokenStore) {}
  async isAuthorized() {
    return (await this.tokens.get()) !== null;
  }
  async listChildFolders() {
    this.calls++;
    if (!(await this.tokens.get())) throw errors.driveNotAuthorized();
    return this.folders;
  }
  async grantedScopes() {
    return [DRIVE_SCOPE];
  }
  async uploadFile(_p: UploadFileParams): Promise<string> {
    throw new Error('not implemented');
  }
  async deleteFile(_id: string): Promise<void> {
    throw new Error('not implemented');
  }
  async ensureChildFolder(_parent: string, _name: string): Promise<string> {
    throw new Error('not implemented');
  }
  async openFile(_id: string): Promise<Readable> {
    throw new Error('not implemented');
  }
}

export interface RecordedUpload extends UploadFileParams {
  id: string;
}

/** Driveの書き込み・読み出しを記録するインメモリ実装。 */
export class FakeGateway extends StubGateway {
  uploads: RecordedUpload[] = [];
  deleted: string[] = [];
  subfolders = new Map<string, string>();
  files = new Map<string, Buffer>();
  /** n番目(1始まり)のuploadFileを失敗させる。 */
  failUploadNumber: number | null = null;
  private seq = 0;

  override async uploadFile(p: UploadFileParams) {
    if (this.failUploadNumber === this.uploads.length + 1) {
      this.failUploadNumber = null;
      throw errors.driveUnavailable();
    }
    const id = `drive-file-${++this.seq}`;
    this.uploads.push({ ...p, id });
    this.files.set(id, p.data);
    return id;
  }
  override async deleteFile(id: string) {
    this.deleted.push(id);
    this.files.delete(id);
  }
  override async ensureChildFolder(parent: string, name: string) {
    const key = `${parent}/${name}`;
    if (!this.subfolders.has(key)) this.subfolders.set(key, `thumbs-of-${parent}`);
    return this.subfolders.get(key)!;
  }
  override async openFile(id: string) {
    const data = this.files.get(id);
    if (!data) throw errors.driveParentInaccessible();
    return Readable.from(data);
  }
}

// 実際の画像処理（sharp + HEIC用ワーカー）をテストでも使う。
export const sharedImages = new SharpImageProcessor();

export function build(
  options: { limiter?: UploadLimiter; extract?: PhotoUploadServiceExtract; images?: ImageProcessor } = {},
) {
  const tokens = new MemoryRefreshTokenStore();
  const states = new MemoryOAuthStateStore();
  const auth = new FakeAuth();
  const google = new FakeGoogle();
  const gateway = new FakeGateway(tokens);
  const regions = new RegionService(gateway);
  const photos = new MemoryPhotoRepository();
  const images = options.images ?? sharedImages;
  const uploads = new PhotoUploadService({ gateway, regions, photos, images, extract: options.extract });
  const originals = new OriginalService({ photos, gateway, images });
  const manage = new PhotoManageService({ photos, gateway, regions, parentFolderId: config.driveParentFolderId });
  const uploadLimiter = options.limiter ?? new UploadLimiter();
  const authorization = new DriveAuthorization({ config, google, states, tokens, isAdmin: (uid) => auth.isAdmin(uid) });
  const app = createApp({ config, auth, authorization, gateway, regions, uploads, photos, originals, manage, uploadLimiter });
  return { app, tokens, states, auth, google, gateway, regions, photos };
}

type PhotoUploadServiceExtract = ConstructorParameters<typeof PhotoUploadService>[0]['extract'];
