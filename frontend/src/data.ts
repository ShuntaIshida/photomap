import { useEffect, useMemo, useState } from 'react';
import {
  collection,
  onSnapshot,
  query,
  where,
  type DocumentData,
  type Timestamp,
} from 'firebase/firestore';
import { db } from './firebase';

export interface LatLng {
  lat: number;
  lng: number;
}

/** regions/{slug}: ドキュメントIDはslugと同一にする。 */
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

/** photos/{photoId}: 書き込みは将来のCloud Run APIのみ。regionIdはregions.idと対応する。 */
export interface Photo {
  id: string;
  regionId: string;
  driveFileId: string;
  originalFilename: string;
  mimeType: string;
  latitude: number | null;
  longitude: number | null;
  capturedAt: Date | null;
  // 撮影日時のタイムゾーンがEXIFに無い場合はfalse（表示は端末ローカル解釈の参考値）。
  capturedAtTimeZoneKnown: boolean;
  uploadedAt: Date | null;
  uploaderUid: string;
  uploaderName: string;
  width: number | null;
  height: number | null;
  hasGps: boolean;
  locationSource: 'exif' | 'manual';
  thumbnailDriveFileId?: string;
}

// Firestoreに地域データが無い間も画面を成立させる初期値。
export const DEFAULT_REGIONS: Region[] = [
  { id: 'yurihonjo', slug: 'yurihonjo', name: '由利本荘', prefecture: '秋田県', defaultCenter: { lat: 39.3853, lng: 140.0488 }, defaultZoom: 12, sortOrder: 1 },
  { id: 'nikaho', slug: 'nikaho', name: 'にかほ', prefecture: '秋田県', defaultCenter: { lat: 39.2, lng: 139.9061 }, defaultZoom: 12, sortOrder: 2 },
];

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const toDate = (v: unknown): Date | null =>
  v && typeof (v as Timestamp).toDate === 'function' ? (v as Timestamp).toDate() : null;

const sortTime = (p: Photo) => (p.capturedAt ?? p.uploadedAt)?.getTime() ?? 0;

function parseRegion(id: string, d: DocumentData): Region | null {
  const c = d.defaultCenter;
  if (typeof d.name !== 'string' || !c || !isNum(c.lat) || !isNum(c.lng)) return null;
  return {
    id,
    name: d.name,
    slug: typeof d.slug === 'string' ? d.slug : id,
    prefecture: typeof d.prefecture === 'string' ? d.prefecture : '',
    defaultCenter: { lat: c.lat, lng: c.lng },
    defaultZoom: isNum(d.defaultZoom) ? d.defaultZoom : 12,
    sortOrder: isNum(d.sortOrder) ? d.sortOrder : 999,
    driveFolderId: typeof d.driveFolderId === 'string' ? d.driveFolderId : undefined,
  };
}

function parsePhoto(id: string, d: DocumentData): Photo | null {
  if (typeof d.regionId !== 'string') return null;
  const hasGps = d.hasGps === true && isNum(d.latitude) && isNum(d.longitude);
  return {
    id,
    regionId: d.regionId,
    driveFileId: typeof d.driveFileId === 'string' ? d.driveFileId : '',
    originalFilename: typeof d.originalFilename === 'string' ? d.originalFilename : id,
    mimeType: typeof d.mimeType === 'string' ? d.mimeType : '',
    latitude: hasGps ? d.latitude : null,
    longitude: hasGps ? d.longitude : null,
    capturedAt: toDate(d.capturedAt),
    capturedAtTimeZoneKnown: d.capturedAtTimeZoneKnown === true,
    uploadedAt: toDate(d.uploadedAt),
    uploaderUid: typeof d.uploaderUid === 'string' ? d.uploaderUid : '',
    uploaderName: typeof d.uploaderName === 'string' ? d.uploaderName : '',
    width: isNum(d.width) ? d.width : null,
    height: isNum(d.height) ? d.height : null,
    hasGps,
    locationSource: d.locationSource === 'manual' ? 'manual' : 'exif',
    thumbnailDriveFileId:
      typeof d.thumbnailDriveFileId === 'string' ? d.thumbnailDriveFileId : undefined,
  };
}

/**
 * Firestoreのregionsを購読し、初期値とslug単位でマージする（Firestore側を優先）。
 * 将来はCloud RunがDriveの地域フォルダ一覧をregionsへ同期する前提。
 */
export function useRegions(): { regions: Region[]; loading: boolean } {
  const [fetched, setFetched] = useState<Region[] | null>(null);
  const [loading, setLoading] = useState(Boolean(db));

  useEffect(() => {
    if (!db) return;
    return onSnapshot(
      collection(db, 'regions'),
      (snap) => {
        setFetched(
          snap.docs
            .map((doc) => parseRegion(doc.id, doc.data()))
            .filter((r): r is Region => r !== null),
        );
        setLoading(false);
      },
      () => {
        setFetched(null);
        setLoading(false);
      },
    );
  }, []);

  const regions = useMemo(() => {
    const bySlug = new Map(DEFAULT_REGIONS.map((r) => [r.slug, r]));
    for (const r of fetched ?? []) bySlug.set(r.slug, r);
    return [...bySlug.values()].sort((a, b) => a.sortOrder - b.sortOrder);
  }, [fetched]);

  return { regions, loading };
}

/** 地域別のphotosを購読する。複合インデックスを避けるため並び替えはクライアント側で行う。 */
export function usePhotos(regionId: string | null) {
  const [state, setState] = useState<{ regionId: string; photos: Photo[]; error: boolean } | null>(null);

  useEffect(() => {
    if (!db || !regionId) return;
    return onSnapshot(
      query(collection(db, 'photos'), where('regionId', '==', regionId)),
      (snap) => {
        const photos = snap.docs
          .map((doc) => parsePhoto(doc.id, doc.data()))
          .filter((p): p is Photo => p !== null)
          .sort((a, b) => sortTime(b) - sortTime(a));
        setState({ regionId, photos, error: false });
      },
      () => setState({ regionId, photos: [], error: true }),
    );
  }, [regionId]);

  const current = state?.regionId === regionId ? state : null;
  return {
    photos: current?.photos ?? [],
    loading: Boolean(db) && Boolean(regionId) && current === null,
    error: current?.error ?? false,
  };
}
