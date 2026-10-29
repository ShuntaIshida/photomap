import { useEffect, useState } from 'react';
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
  { id: 'akita', slug: 'akita', name: '秋田', prefecture: '秋田県', defaultCenter: { lat: 39.7186, lng: 140.1024 }, defaultZoom: 12, sortOrder: 2 },
  { id: 'noshiro', slug: 'noshiro', name: '能代', prefecture: '秋田県', defaultCenter: { lat: 40.2122, lng: 140.0278 }, defaultZoom: 12, sortOrder: 3 },
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

/** Firestoreのregionsを購読する。未設定・0件・エラー時は初期値にフォールバックする。 */
export function useRegions(): Region[] {
  const [regions, setRegions] = useState<Region[]>(DEFAULT_REGIONS);

  useEffect(() => {
    if (!db) return;
    return onSnapshot(
      collection(db, 'regions'),
      (snap) => {
        const list = snap.docs
          .map((doc) => parseRegion(doc.id, doc.data()))
          .filter((r): r is Region => r !== null)
          .sort((a, b) => a.sortOrder - b.sortOrder);
        setRegions(list.length ? list : DEFAULT_REGIONS);
      },
      () => setRegions(DEFAULT_REGIONS),
    );
  }, []);

  return regions;
}

/** 地域別のphotosを購読する。複合インデックスを避けるため並び替えはクライアント側で行う。 */
export function usePhotos(regionId: string) {
  const [state, setState] = useState<{ regionId: string; photos: Photo[]; error: boolean } | null>(null);

  useEffect(() => {
    if (!db) return;
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
    loading: Boolean(db) && current === null,
    error: current?.error ?? false,
  };
}
