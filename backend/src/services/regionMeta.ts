import { errors } from '../errors.js';
import { log } from '../logger.js';
import type { LatLng, RegionMetadata, RegionRepository, StoredRegion } from '../stores/regionRepository.js';
import type { RegionListing, RegionService } from './regions.js';

type Seed = Omit<RegionMetadata, 'slug'>;

/** 既知の地域の初期値。Firestoreに未登録のときだけ、新規登録の初期値として使う（上書きはしない）。 */
export const REGION_SEEDS: Readonly<Record<string, Seed>> = {
  yurihonjo: { displayName: '由利本荘', center: { lat: 39.3853, lng: 140.0488 }, zoom: 12 }, // 秋田県由利本荘市
  nikaho: { displayName: 'にかほ', center: { lat: 39.2, lng: 139.9061 }, zoom: 12 }, // 秋田県にかほ市
  ogaki: { displayName: '大垣', center: { lat: 35.3593, lng: 136.6128 }, zoom: 12 }, // 岐阜県大垣市
};

const MAX_NAME_LENGTH = 50;
const MIN_ZOOM = 1;
const MAX_ZOOM = 21;
// Firestoreが不調のときに、地域一覧の取得ごとに再試行し続けない。
const FAILURE_BACKOFF_MS = 30_000;

export interface AdminRegion {
  slug: string;
  driveFolderId: string;
  configured: boolean;
  displayName: string | null;
  center: LatLng | null;
  zoom: number | null;
}

/** 保存する値を検証・正規化する。 */
export function parseRegionInput(input: unknown): Omit<RegionMetadata, 'slug'> {
  const body = (typeof input === 'object' && input !== null ? input : {}) as { displayName?: unknown; center?: { lat?: unknown; lng?: unknown } | null; zoom?: unknown };
  const name = typeof body.displayName === 'string' ? body.displayName.normalize('NFC').trim() : '';
  if (!name || [...name].length > MAX_NAME_LENGTH || /\p{Cc}/u.test(name)) throw errors.invalidRegionMetadata('displayName must be 1-50 characters without control characters');
  const lat = body.center?.lat;
  const lng = body.center?.lng;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw errors.invalidRegionMetadata('center must be a valid latitude/longitude');
  }
  const zoom = body.zoom;
  if (typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom < MIN_ZOOM || zoom > MAX_ZOOM) throw errors.invalidRegionMetadata(`zoom must be between ${MIN_ZOOM} and ${MAX_ZOOM}`);
  const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
  return { displayName: name, center: { lat: round(lat, 6), lng: round(lng, 6) }, zoom: round(zoom, 2) };
}

/**
 * Driveのフォルダー（地域の存在・保存先）とFirestoreの地域メタデータ（表示設定）をつなぐ。
 * 新しいフォルダーが見つかったときだけ1回登録し、既存のメタデータは上書きしない。
 */
export class RegionMetaService {
  private readonly ensured = new Set<string>();
  private lastFailureAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly deps: { repo: RegionRepository; regions: RegionService; seeds?: Readonly<Record<string, Seed>>; now?: () => number },
  ) {}

  private get seeds() {
    return this.deps.seeds ?? REGION_SEEDS;
  }

  /** 一覧にあって未登録の地域を登録する。失敗しても地域一覧の返却は妨げない。 */
  async ensureRegistered(listing: RegionListing): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    const pending = listing.regions.filter((r) => !this.ensured.has(`${r.slug}:${r.driveFolderId}`));
    if (pending.length === 0) return;
    if (now - this.lastFailureAt < FAILURE_BACKOFF_MS) return;
    this.inflight ??= (async () => {
      try {
        const stored = new Map((await this.deps.repo.list()).map((r) => [r.slug, r]));
        for (const region of pending) {
          const existing = stored.get(region.slug);
          if (existing) {
            if (existing.driveFolderId && existing.driveFolderId !== region.driveFolderId) {
              log('WARNING', 'region folder id differs from the registered one', { slug: region.slug });
            }
          } else {
            const seed = Object.hasOwn(this.seeds, region.slug) ? this.seeds[region.slug] : undefined;
            await this.deps.repo.createIfAbsent(region.slug, { driveFolderId: region.driveFolderId, metadata: seed });
            log('INFO', 'region registered', { slug: region.slug, configured: seed !== undefined });
          }
          this.ensured.add(`${region.slug}:${region.driveFolderId}`);
        }
      } catch {
        this.lastFailureAt = (this.deps.now ?? Date.now)();
        log('WARNING', 'region registration failed; will retry later');
      } finally {
        this.inflight = null;
      }
    })();
    await this.inflight;
  }

  /** 管理画面用。Driveの最新の一覧（正本）にFirestoreの設定を合わせて返す。 */
  async adminList(): Promise<{ regions: AdminRegion[]; ignored: RegionListing['ignored'] }> {
    const listing = await this.deps.regions.list({ fresh: true });
    await this.ensureRegistered(listing);
    const stored = new Map((await this.deps.repo.list()).map((r) => [r.slug, r]));
    return {
      regions: listing.regions.map((r) => this.merge(r.slug, r.driveFolderId, stored.get(r.slug))),
      ignored: listing.ignored,
    };
  }

  private merge(slug: string, driveFolderId: string, s: StoredRegion | undefined): AdminRegion {
    return {
      slug,
      driveFolderId,
      configured: s?.configured ?? false,
      displayName: s?.displayName ?? null,
      center: s?.center ?? null,
      zoom: s?.zoom ?? null,
    };
  }

  /** Driveに存在する地域だけ保存できる（Firestoreの設定だけで地域を公開しない）。 */
  async save(uid: string, slug: string, input: unknown): Promise<AdminRegion> {
    const meta = parseRegionInput(input);
    const { regions } = await this.deps.regions.list({ fresh: true });
    const region = regions.find((r) => r.slug === slug);
    if (!region) throw errors.regionNotFound();
    await this.deps.repo.save(slug, meta, region.driveFolderId, uid);
    this.ensured.add(`${slug}:${region.driveFolderId}`);
    log('INFO', 'region metadata saved', { uid, slug });
    return { slug, driveFolderId: region.driveFolderId, configured: true, ...meta };
  }
}
