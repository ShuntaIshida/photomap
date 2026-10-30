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
import { resolveApiBase } from './lib/apiBase';
import { buildRegions, resolveSlugs, type Region } from './regionList';

export type { Region } from './regionList';

export const API_BASE = resolveApiBase(import.meta.env.VITE_API_BASE_URL);
const FETCH_TIMEOUT_MS = 8000;

/** photos/{photoId}: 書き込みは将来のCloud Run APIのみ。regionIdは地域のslugと対応する。 */
export interface Photo {
  id: string;
  regionId: string;
  driveFileId: string;
  originalFilename: string;
  /** 表示用タイトル（Firestoreのtitle）。未設定は空文字で、その場合はoriginalFilenameを表示する。 */
  title: string;
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

/** 一覧・詳細・マーカーで表示する名前。タイトル未設定なら従来のファイル名。 */
export const photoName = (p: Pick<Photo, 'title' | 'originalFilename'>) => p.title || p.originalFilename;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const toDate = (v: unknown): Date | null =>
  v && typeof (v as Timestamp).toDate === 'function' ? (v as Timestamp).toDate() : null;

const sortTime = (p: Photo) => (p.capturedAt ?? p.uploadedAt)?.getTime() ?? 0;

/** 新形式（displayName/center/zoom）を優先し、旧形式（name/defaultCenter/defaultZoom）も読む。表示設定が未入力のドキュメントは対象外。 */
function parseRegion(id: string, d: DocumentData): Region | null {
  const c = d.center ?? d.defaultCenter;
  const name = typeof d.displayName === 'string' && d.displayName ? d.displayName : typeof d.name === 'string' ? d.name : '';
  const zoom = isNum(d.zoom) ? d.zoom : isNum(d.defaultZoom) ? d.defaultZoom : null;
  if (!name || zoom === null || !c || !isNum(c.lat) || !isNum(c.lng)) return null;
  return {
    id,
    name,
    slug: typeof d.slug === 'string' ? d.slug : id,
    prefecture: typeof d.prefecture === 'string' ? d.prefecture : '',
    defaultCenter: { lat: c.lat, lng: c.lng },
    defaultZoom: zoom,
    configured: true,
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
    title: typeof d.title === 'string' ? d.title : '',
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
 * URLが有効な地域の判定に使う一覧。正本はGoogle Drive（バックエンドの公開GET /regions）で、画面での地域一覧表示には使わない。
 * 取得はページ読み込みごと。失敗時のフォールバックはresolveSlugsを参照。
 * Firestoreのregionsは既知地域以外の表示名・初期座標のメタデータとしてのみ使う（存在判定には使わない）。
 */
export function useRegions(): { regions: Region[]; loading: boolean } {
  const [slugs, setSlugs] = useState<string[] | null>(null);
  const [meta, setMeta] = useState<Region[]>([]);
  // 最初のFirestoreの応答（または失敗）が来るまで待ち、地図が既定値から設定値へ飛ばないようにする。
  const [metaReady, setMetaReady] = useState(!db);

  useEffect(() => {
    let active = true;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    (async () => {
      const result = await resolveSlugs({
        apiBase: API_BASE,
        fetchFn: (url, init) => fetch(url, init),
        storage: safeStorage(),
        signal: ctrl.signal,
      });
      if (active) setSlugs(result);
    })();

    return () => {
      active = false;
      clearTimeout(timer);
      ctrl.abort();
    };
  }, []);

  useEffect(() => {
    if (!db) return;
    return onSnapshot(
      collection(db, 'regions'),
      (snap) => {
        setMeta(
          snap.docs
            .map((doc) => parseRegion(doc.id, doc.data()))
            .filter((r): r is Region => r !== null),
        );
        setMetaReady(true);
      },
      () => {
        setMeta([]);
        setMetaReady(true);
      },
    );
  }, []);

  const regions = useMemo(() => (slugs ? buildRegions(slugs, meta) : []), [slugs, meta]);
  return { regions, loading: slugs === null || !metaReady };
}

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
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
