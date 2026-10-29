import { drive } from '@googleapis/drive';
import type { Config } from '../config.js';
import { AppError, errors } from '../errors.js';
import { log } from '../logger.js';
import type { RefreshTokenStore } from '../stores/refreshTokenStore.js';
import type { GoogleOAuth } from './googleOAuth.js';

export interface DriveFolder {
  id: string;
  name: string;
}

export interface DriveGateway {
  isAuthorized(): Promise<boolean>;
  /** 親フォルダー直下のフォルダー（ゴミ箱除く）を列挙する。読み取り専用。 */
  listChildFolders(): Promise<DriveFolder[]>;
}

function mapGoogleError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const err = e as { code?: number | string; status?: number; message?: string; response?: { status?: number; data?: { error?: string } } };
  const status = err.response?.status ?? err.status ?? (typeof err.code === 'number' ? err.code : undefined);
  if (err.response?.data?.error === 'invalid_grant' || /invalid_grant/.test(err.message ?? '')) return errors.driveAuthInvalid();
  if (status === 401) return errors.driveAuthInvalid();
  if (status === 403 || status === 404) return errors.driveParentInaccessible();
  return errors.driveUnavailable();
}

export class GoogleDriveGateway implements DriveGateway {
  constructor(
    private readonly config: Config,
    private readonly google: GoogleOAuth,
    private readonly tokens: RefreshTokenStore,
  ) {}

  async isAuthorized() {
    return (await this.tokens.get()) !== null;
  }

  async listChildFolders(): Promise<DriveFolder[]> {
    const refreshToken = await this.tokens.get();
    if (!refreshToken) throw errors.driveNotAuthorized();

    const api = drive({ version: 'v3', auth: this.google.clientFor(refreshToken) });
    const folders: DriveFolder[] = [];
    let pageToken: string | undefined;
    try {
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
    } catch (e) {
      const mapped = mapGoogleError(e);
      log('ERROR', 'drive folder listing failed', { code: mapped.code });
      throw mapped;
    }
    return folders;
  }
}
