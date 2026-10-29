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

/** Drive APIの利用枠を守るため、一覧を短時間キャッシュし同時リクエストを1回にまとめる。 */
export class RegionService {
  private cache: { at: number; value: RegionListing } | null = null;
  private inflight: Promise<RegionListing> | null = null;

  constructor(private readonly gateway: DriveGateway) {}

  invalidate() {
    this.cache = null;
  }

  async list({ fresh = false } = {}): Promise<RegionListing> {
    if (!fresh && this.cache && Date.now() - this.cache.at < TTL_MS) return this.cache.value;
    this.inflight ??= this.gateway
      .listChildFolders()
      .then((folders) => {
        const value = toRegions(folders);
        this.cache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
}
