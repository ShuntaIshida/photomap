import { log } from '../logger.js';
import type { DriveFolder, DriveGateway } from './driveGateway.js';

export interface DriveRegion {
  slug: string;
  driveFolderId: string;
}

export interface IgnoredFolder {
  name: string;
  reason: 'invalid_slug' | 'duplicate_name';
}

export interface RegionListing {
  regions: DriveRegion[];
  ignored: IgnoredFolder[];
}

// URLにそのまま使えるslugのみ許可（フォルダー名＝slug）。
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 64;

export function toRegions(folders: readonly DriveFolder[]): RegionListing {
  const bySlug = new Map<string, DriveFolder[]>();
  const ignored: IgnoredFolder[] = [];
  for (const f of folders) {
    if (f.name.length > MAX_SLUG_LENGTH || !SLUG_PATTERN.test(f.name)) {
      ignored.push({ name: f.name, reason: 'invalid_slug' });
      continue;
    }
    bySlug.set(f.name, [...(bySlug.get(f.name) ?? []), f]);
  }
  const regions: DriveRegion[] = [];
  for (const [slug, group] of bySlug) {
    // 同名フォルダーはどれが正かDriveから判別できないため、どちらも採用しない。
    if (group.length > 1) {
      ignored.push(...group.map(() => ({ name: slug, reason: 'duplicate_name' as const })));
    } else {
      regions.push({ slug, driveFolderId: group[0]!.id });
    }
  }
  regions.sort((a, b) => a.slug.localeCompare(b.slug));
  return { regions, ignored };
}

const TTL_MS = 60_000;
// Driveへの取得に失敗したとき、直近の成功結果をこの期間は代わりに返す。
// 一時的な障害で地域一覧が空にならないようにする。
const STALE_MAX_MS = 24 * 60 * 60 * 1000;
// 失敗直後の再試行を抑え、障害中に公開エンドポイントがDrive APIを叩き続けないようにする。
const FAILURE_BACKOFF_MS = 10_000;

/** Drive APIの利用枠を守るため、一覧を短時間キャッシュし同時リクエストを 1回にまとめる。 */
export class RegionService {
  private cache: { at: number; value: RegionListing } | null = null;
  private inflight: Promise<RegionListing> | null = null;
  private failure: { at: number; error: unknown } | null = null;

  constructor(private readonly gateway: DriveGateway) {}

  invalidate() {
    this.cache = null;
    this.failure = null;
  }

  /** `fresh`は管理者向け。キャッシュも古い結果も使わず、失敗はそのまま返す。 */
  async list({ fresh = false } = {}): Promise<RegionListing> {
    const now = Date.now();
    if (!fresh && this.cache && now - this.cache.at < TTL_MS) return this.cache.value;

    if (!fresh && this.failure && now - this.failure.at < FAILURE_BACKOFF_MS) {
      return this.staleOrThrow(this.failure.error);
    }

    this.inflight ??= this.gateway
      .listChildFolders()
      .then((folders) => {
        const value = toRegions(folders);
        this.cache = { at: Date.now(), value };
        this.failure = null;
        return value;
      })
      .catch((error: unknown) => {
        this.failure = { at: Date.now(), error };
        throw error;
      })
      .finally(() => {
        this.inflight = null;
      });

    try {
      return await this.inflight;
    } catch (error) {
      if (fresh) throw error;
      return this.staleOrThrow(error);
    }
  }

  private staleOrThrow(error: unknown): RegionListing {
    if (this.cache && Date.now() - this.cache.at < STALE_MAX_MS) {
      log('WARNING', 'serving stale region list after Drive failure', {
        ageSec: Math.round((Date.now() - this.cache.at) / 1000),
      });
      return this.cache.value;
    }
    throw error;
  }
}
