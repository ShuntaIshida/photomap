import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

export interface RefreshTokenStore {
  get(): Promise<string | null>;
  save(token: string): Promise<void>;
}

const NOT_FOUND = 5;
const CACHE_MS = 60_000;

/**
 * リフレッシュトークンをSecret Managerの最新バージョンとして保持する。
 * 事前にシークレット（空）を作成し、実行SAに accessor / secretVersionAdder を付与しておく。
 */
export class SecretManagerRefreshTokenStore implements RefreshTokenStore {
  private cache: { value: string | null; at: number } | null = null;

  constructor(
    private readonly projectId: string,
    private readonly secretName: string,
    private readonly client = new SecretManagerServiceClient(),
  ) {}

  private get parent() {
    return `projects/${this.projectId}/secrets/${this.secretName}`;
  }

  async get(): Promise<string | null> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.value;
    let value: string | null = null;
    try {
      const [version] = await this.client.accessSecretVersion({ name: `${this.parent}/versions/latest` });
      value = version.payload?.data?.toString().trim() || null;
    } catch (e) {
      // バージョン未作成（未認可）は「未設定」として扱う。
      if ((e as { code?: number }).code !== NOT_FOUND) throw e;
    }
    this.cache = { value, at: Date.now() };
    return value;
  }

  async save(token: string): Promise<void> {
    await this.client.addSecretVersion({ parent: this.parent, payload: { data: Buffer.from(token, 'utf8') } });
    this.cache = { value: token, at: Date.now() };
  }
}

export class MemoryRefreshTokenStore implements RefreshTokenStore {
  constructor(private token: string | null = null) {}
  async get() {
    return this.token;
  }
  async save(token: string) {
    this.token = token;
  }
}
