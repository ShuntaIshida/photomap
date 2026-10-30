import { FieldValue, getFirestore } from 'firebase-admin/firestore';

export interface LatLng {
  lat: number;
  lng: number;
}

/** 地域の表示設定。slugはGoogle Driveのフォルダー名で、URLにも使う。 */
export interface RegionMetadata {
  slug: string;
  displayName: string;
  center: LatLng;
  zoom: number;
}

/** Firestoreに保存されている地域。表示設定が未入力の間はconfiguredがfalse。 */
export interface StoredRegion {
  slug: string;
  driveFolderId: string | null;
  configured: boolean;
  displayName: string | null;
  center: LatLng | null;
  zoom: number | null;
}

export interface NewRegionDoc {
  driveFolderId: string;
  /** 既知の地域の初期値。無ければ未設定（管理者が設定する）で登録する。 */
  metadata?: Omit<RegionMetadata, 'slug'>;
}

export interface RegionRepository {
  list(): Promise<StoredRegion[]>;
  /** 既にあるドキュメントは一切変更しない（冪等な新規登録）。 */
  createIfAbsent(slug: string, doc: NewRegionDoc): Promise<'created' | 'exists'>;
  /** 管理者による保存。表示設定だけを更新し、登録日などは残す。 */
  save(slug: string, meta: Omit<RegionMetadata, 'slug'>, driveFolderId: string, uid: string): Promise<void>;
}

const ALREADY_EXISTS = 6;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseLatLng(v: unknown): LatLng | null {
  const c = v as { lat?: unknown; lng?: unknown } | null | undefined;
  return c && num(c.lat) && num(c.lng) ? { lat: c.lat, lng: c.lng } : null;
}

/** 新形式（displayName/center/zoom）を優先し、旧形式（name/defaultCenter/defaultZoom）も読む。 */
export function parseStoredRegion(slug: string, d: Record<string, unknown>): StoredRegion {
  const displayName = typeof d.displayName === 'string' && d.displayName ? d.displayName : typeof d.name === 'string' && d.name ? d.name : null;
  const center = parseLatLng(d.center) ?? parseLatLng(d.defaultCenter);
  const zoom = num(d.zoom) ? d.zoom : num(d.defaultZoom) ? d.defaultZoom : null;
  return {
    slug,
    driveFolderId: typeof d.driveFolderId === 'string' && d.driveFolderId ? d.driveFolderId : null,
    configured: displayName !== null && center !== null && zoom !== null,
    displayName,
    center,
    zoom,
  };
}

// 旧フロントエンド（name/defaultCenter/defaultZoomを読む）との互換用に同じ値を書く。
const mirror = (m: Omit<RegionMetadata, 'slug'>) => ({
  displayName: m.displayName,
  center: m.center,
  zoom: m.zoom,
  name: m.displayName,
  defaultCenter: m.center,
  defaultZoom: m.zoom,
});

export class FirestoreRegionRepository implements RegionRepository {
  private get col() {
    return getFirestore().collection('regions');
  }

  async list(): Promise<StoredRegion[]> {
    const snap = await this.col.get();
    return snap.docs.map((doc) => parseStoredRegion(doc.id, doc.data()));
  }

  async createIfAbsent(slug: string, { driveFolderId, metadata }: NewRegionDoc): Promise<'created' | 'exists'> {
    try {
      await this.col.doc(slug).create({
        slug,
        driveFolderId,
        status: metadata ? 'configured' : 'unconfigured',
        source: metadata ? 'seed' : 'drive',
        createdAt: FieldValue.serverTimestamp(),
        ...(metadata ? mirror(metadata) : {}),
      });
      return 'created';
    } catch (e) {
      if ((e as { code?: number }).code === ALREADY_EXISTS) return 'exists';
      throw e;
    }
  }

  async save(slug: string, meta: Omit<RegionMetadata, 'slug'>, driveFolderId: string, uid: string): Promise<void> {
    await this.col.doc(slug).set(
      { slug, driveFolderId, status: 'configured', ...mirror(meta), updatedAt: FieldValue.serverTimestamp(), updatedBy: uid },
      { merge: true },
    );
  }
}

export class MemoryRegionRepository implements RegionRepository {
  readonly docs = new Map<string, Record<string, unknown>>();
  failNext = false;
  reads = 0;

  async list() {
    this.reads++;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('firestore unavailable');
    }
    return [...this.docs].map(([slug, d]) => parseStoredRegion(slug, d));
  }

  async createIfAbsent(slug: string, { driveFolderId, metadata }: NewRegionDoc) {
    if (this.docs.has(slug)) return 'exists' as const;
    this.docs.set(slug, { slug, driveFolderId, status: metadata ? 'configured' : 'unconfigured', ...(metadata ? mirror(metadata) : {}) });
    return 'created' as const;
  }

  async save(slug: string, meta: Omit<RegionMetadata, 'slug'>, driveFolderId: string, uid: string) {
    this.docs.set(slug, { ...this.docs.get(slug), slug, driveFolderId, status: 'configured', ...mirror(meta), updatedBy: uid });
  }
}
