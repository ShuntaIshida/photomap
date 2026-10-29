export interface LatLng {
  lat: number;
  lng: number;
}

/** 表示用の地域情報。一覧（どの地域が存在するか）はDriveが正本で、ここは表示メタデータ。 */
export interface Region {
  id: string;
  name: string;
  slug: string;
  prefecture: string;
  defaultCenter: LatLng;
  defaultZoom: number;
  sortOrder: number;
  driveFolderId?: string;
}

// 表示名・初期座標をコード側で固定する既知の地域。存在するかどうかはDriveの一覧で決まる。
export const DEFAULT_REGIONS: Region[] = [
  { id: 'yurihonjo', slug: 'yurihonjo', name: '由利本荘', prefecture: '秋田県', defaultCenter: { lat: 39.3853, lng: 140.0488 }, defaultZoom: 12, sortOrder: 1 },
  { id: 'nikaho', slug: 'nikaho', name: 'にかほ', prefecture: '秋田県', defaultCenter: { lat: 39.2, lng: 139.9061 }, defaultZoom: 12, sortOrder: 2 },
];

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// メタデータが無い新規地域は秋田県全体を表示する。
const FALLBACK_CENTER: LatLng = { lat: 39.72, lng: 140.1 };
const FALLBACK_ZOOM = 9;

/** `GET /regions`のレスポンスからslugを取り出す。形式が不正なら例外（空一覧とは区別する）。 */
export function parseSlugResponse(body: unknown): string[] {
  const list = (body as { regions?: unknown } | null)?.regions;
  if (!Array.isArray(list)) throw new Error('invalid regions response');
  const slugs = new Set<string>();
  for (const item of list) {
    const slug = (item as { slug?: unknown } | null)?.slug;
    if (typeof slug === 'string' && SLUG_PATTERN.test(slug)) slugs.add(slug);
  }
  return [...slugs];
}

/** Driveのslug一覧を表示用のRegionに変換する。固定メタデータ→Firestore→フォルダー名の順で名前等を決める。 */
export function buildRegions(slugs: readonly string[], firestoreMeta: readonly Region[]): Region[] {
  const builtin = new Map(DEFAULT_REGIONS.map((r) => [r.slug, r]));
  const meta = new Map(firestoreMeta.map((r) => [r.slug, r]));
  return slugs
    .map((slug): Region => {
      const known = builtin.get(slug);
      if (known) return known;
      const fromStore = meta.get(slug);
      if (fromStore) return { ...fromStore, id: slug };
      return { id: slug, slug, name: slug, prefecture: '', defaultCenter: FALLBACK_CENTER, defaultZoom: FALLBACK_ZOOM, sortOrder: 999 };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.slug.localeCompare(b.slug));
}

const CACHE_KEY = 'photomap.driveRegions.v1';

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'setItem'>;

/** 直近に取得できたslug一覧。取得失敗時に地域を消さないための退避先。 */
export function loadLastKnownSlugs(storage: ReadableStorage | undefined): string[] | null {
  try {
    const raw = storage?.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const slugs = parsed.filter((s): s is string => typeof s === 'string' && SLUG_PATTERN.test(s));
    return slugs.length ? slugs : null;
  } catch {
    return null;
  }
}

export function saveLastKnownSlugs(storage: WritableStorage | undefined, slugs: readonly string[]): void {
  try {
    storage?.setItem(CACHE_KEY, JSON.stringify(slugs));
  } catch {
    // 容量超過・プライベートモード等は無視（キャッシュは任意）。
  }
}

export interface SlugSourceOptions {
  /** Cloud Run APIのベースURL。空ならAPIを使わない。 */
  apiBase: string;
  fetchFn: (url: string, init?: { signal?: AbortSignal }) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;
  storage?: ReadableStorage & WritableStorage;
  signal?: AbortSignal;
}

/**
 * URLが有効な地域（Drive直下フォルダーのslug）の一覧を決める。
 * 取得成功→その一覧（空も有効）を保存。失敗→直近の一覧→無ければ既知の地域。失敗時には何も保存・削除しない。
 */
export async function resolveSlugs({ apiBase, fetchFn, storage, signal }: SlugSourceOptions): Promise<string[]> {
  if (apiBase) {
    try {
      const res = await fetchFn(`${apiBase}/regions`, { signal });
      if (!res.ok) throw new Error(`regions ${res.status}`);
      const slugs = parseSlugResponse(await res.json());
      saveLastKnownSlugs(storage, slugs);
      return slugs;
    } catch {
      const last = loadLastKnownSlugs(storage);
      if (last) return last;
    }
  }
  return DEFAULT_REGIONS.map((r) => r.slug);
}
