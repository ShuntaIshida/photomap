import { Readable } from 'node:stream';
import { drive, type drive_v3 } from '@googleapis/drive';
import type { Config } from '../config.js';
import { AppError, errors } from '../errors.js';
import { log } from '../logger.js';
import type { RefreshTokenStore } from '../stores/refreshTokenStore.js';
import type { GoogleOAuth } from './googleOAuth.js';

export interface DriveFolder {
  id: string;
  name: string;
}

export interface UploadFileParams {
  parentId: string;
  name: string;
  mimeType: string;
  data: Buffer;
  appProperties?: Record<string, string>;
}

export interface DriveGateway {
  isAuthorized(): Promise<boolean>;
  /** 親フォルダー直下のフォルダー（ゴミ箱除く）を列挙する。 */
  listChildFolders(): Promise<DriveFolder[]>;
  /** 付与済みスコープ。取得できなければ空。 */
  grantedScopes(): Promise<string[]>;
  /** parentId直下にファイルを作成し、DriveファイルIDを返す。公開権限は付与しない。 */
  uploadFile(params: UploadFileParams): Promise<string>;
  /** このサービスが作成したファイルの後始末用。 */
  deleteFile(fileId: string): Promise<void>;
  /** parentId直下の同名フォルダーを再利用し、無ければ作成する。 */
  ensureChildFolder(parentId: string, name: string): Promise<string>;
  /** Firestoreに登録済みのファイルIDのみを渡して読み出す（呼び出し側が検証する）。 */
  openFile(fileId: string): Promise<Readable>;
}

function status(e: unknown): number | undefined {
  const err = e as { code?: number | string; status?: number; response?: { status?: number } };
  return err.response?.status ?? err.status ?? (typeof err.code === 'number' ? err.code : undefined);
}

function isScopeError(e: unknown): boolean {
  const err = e as { message?: string; response?: { data?: unknown } };
  const text = `${err.message ?? ''} ${JSON.stringify(err.response?.data ?? '')}`;
  return /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient (authentication scopes|permission)/i.test(text);
}

export function mapGoogleError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const err = e as { message?: string; response?: { data?: { error?: string } } };
  if (err.response?.data?.error === 'invalid_grant' || /invalid_grant/.test(err.message ?? '')) return errors.driveAuthInvalid();
  const code = status(e);
  if (code === 401) return errors.driveAuthInvalid();
  if (code === 403 && isScopeError(e)) return errors.driveScopeInsufficient();
  if (code === 403 || code === 404) return errors.driveParentInaccessible();
  return errors.driveUnavailable();
}

// Driveクエリのリテラルに埋め込む文字列のエスケープ。
const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export class GoogleDriveGateway implements DriveGateway {
  private readonly subfolders = new Map<string, string>();

  constructor(
    private readonly config: Config,
    private readonly google: GoogleOAuth,
    private readonly tokens: RefreshTokenStore,
  ) {}

  async isAuthorized() {
    return (await this.tokens.get()) !== null;
  }

  async grantedScopes(): Promise<string[]> {
    const token = await this.tokens.get();
    return token ? this.google.grantedScopes(token) : [];
  }

  private async api(): Promise<drive_v3.Drive> {
    const refreshToken = await this.tokens.get();
    if (!refreshToken) throw errors.driveNotAuthorized();
    return drive({ version: 'v3', auth: this.google.clientFor(refreshToken) });
  }

  private async run<T>(op: string, fn: (api: drive_v3.Drive) => Promise<T>): Promise<T> {
    const api = await this.api();
    try {
      return await fn(api);
    } catch (e) {
      const mapped = mapGoogleError(e);
      log('ERROR', 'drive request failed', { op, code: mapped.code });
      throw mapped;
    }
  }

  listChildFolders(): Promise<DriveFolder[]> {
    return this.run('listChildFolders', async (api) => {
      const folders: DriveFolder[] = [];
      let pageToken: string | undefined;
      do {
        const res = await api.files.list({
          // 親フォルダーIDはconfigで形式検証済み。
          q: `'${this.config.driveParentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
          fields: 'nextPageToken, files(id, name)',
          pageSize: 200,
          pageToken,
          orderBy: 'name',
        });
        for (const f of res.data.files ?? []) {
          if (f.id && f.name) folders.push({ id: f.id, name: f.name });
        }
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
      return folders;
    });
  }

  uploadFile({ parentId, name, mimeType, data, appProperties }: UploadFileParams): Promise<string> {
    return this.run('uploadFile', async (api) => {
      const res = await api.files.create({
        requestBody: { name, parents: [parentId], appProperties },
        media: { mimeType, body: Readable.from(data) },
        fields: 'id',
      });
      if (!res.data.id) throw new Error('Drive returned no file id');
      return res.data.id;
    });
  }

  deleteFile(fileId: string): Promise<void> {
    return this.run('deleteFile', async (api) => {
      await api.files.delete({ fileId });
    });
  }

  async ensureChildFolder(parentId: string, name: string): Promise<string> {
    const key = `${parentId}/${name}`;
    const cached = this.subfolders.get(key);
    if (cached) return cached;
    const id = await this.run('ensureChildFolder', async (api) => {
      const found = await api.files.list({
        q: `'${q(parentId)}' in parents and name = '${q(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id)',
        pageSize: 1,
      });
      const existing = found.data.files?.[0]?.id;
      if (existing) return existing;
      const created = await api.files.create({
        requestBody: { name, parents: [parentId], mimeType: 'application/vnd.google-apps.folder' },
        fields: 'id',
      });
      if (!created.data.id) throw new Error('Drive returned no folder id');
      return created.data.id;
    });
    this.subfolders.set(key, id);
    return id;
  }

  openFile(fileId: string): Promise<Readable> {
    return this.run('openFile', async (api) => {
      const res = await api.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
      return res.data as unknown as Readable;
    });
  }
}

