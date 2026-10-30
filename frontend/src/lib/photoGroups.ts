import type { Photo } from '../data';

/** 地図に載せられる写真（GPSあり）。takenAtMsは撮影日時、無ければアップロード日時、どちらも無ければ0。 */
export interface PhotoPoint extends Photo {
  latitude: number;
  longitude: number;
  takenAtMs: number;
}

export interface PhotoGroup {
  key: string;
  lat: number;
  lng: number;
  /** 撮影日時の新しい順。 */
  photos: PhotoPoint[];
}

export function toPhotoPoint(photo: Photo): PhotoPoint | null {
  if (!photo.hasGps || photo.latitude === null || photo.longitude === null) return null;
  const date = photo.capturedAt ?? photo.uploadedAt;
  return { ...photo, latitude: photo.latitude, longitude: photo.longitude, takenAtMs: date?.getTime() ?? 0 };
}

/** 新しい順。同時刻はIDで並べ、並びを安定させる（差分更新の署名に使うため）。 */
export function sortPhotosDescByTakenAt<T extends { takenAtMs: number; id: string }>(photos: readonly T[]): T[] {
  return [...photos].sort((a, b) => b.takenAtMs - a.takenAtMs || a.id.localeCompare(b.id));
}

/** 代表写真は撮影日時が最も新しい写真（nagareyama-photoのpickRepresentativePhotoと同じ）。 */
export function pickRepresentativePhoto<T extends { takenAtMs: number }>(photos: readonly T[]): T | undefined {
  let best = photos[0];
  for (let i = 1; i < photos.length; i += 1) {
    if (photos[i]!.takenAtMs > best!.takenAtMs) best = photos[i];
  }
  return best;
}

/** 同一GPS座標（小数5桁≒1m）の写真を1つのグループにまとめる。 */
export function groupPhotosByLocation(points: readonly PhotoPoint[]): PhotoGroup[] {
  const byKey = new Map<string, PhotoGroup>();
  for (const p of points) {
    const key = `${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`;
    const existing = byKey.get(key);
    if (existing) existing.photos.push(p);
    else byKey.set(key, { key, lat: p.latitude, lng: p.longitude, photos: [p] });
  }
  return [...byKey.values()].map((g) => ({ ...g, photos: sortPhotosDescByTakenAt(g.photos) }));
}

/** グループの中身が変わったかを判定するための署名（構成する写真IDの並び）。 */
export function groupSignature(group: PhotoGroup): string {
  return group.photos.map((p) => p.id).join('|');
}

export interface GroupDiff {
  add: PhotoGroup[];
  remove: string[];
}

/**
 * 前回のグループ(key→署名)と今回を比べ、作り直しが必要なものだけを返す。
 * 署名が同じグループのマーカーは再生成しない（写真が大量でもマーカーの再生成を抑える）。
 */
export function diffGroups(previous: ReadonlyMap<string, string>, next: readonly PhotoGroup[]): GroupDiff {
  const add: PhotoGroup[] = [];
  const addKeys = new Set<string>();
  const nextKeys = new Set<string>();
  for (const g of next) {
    nextKeys.add(g.key);
    if (previous.get(g.key) !== groupSignature(g)) {
      add.push(g);
      addKeys.add(g.key);
    }
  }
  const remove: string[] = [];
  for (const key of previous.keys()) {
    // 署名が変わったグループは「削除してから追加」になる。
    if (!nextKeys.has(key) || addKeys.has(key)) remove.push(key);
  }
  return { add, remove };
}

export function createPhotoCountLabel(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/** クラスタのサムネイル寸法。件数が多いほど大きくする（nagareyama-photoと同じ閾値）。 */
export function clusterMarkerSize(count: number): number {
  return count > 200 ? 60 : count > 40 ? 56 : 52;
}

export const SINGLE_MARKER_SIZE = 48;
export const SWIPE_THRESHOLD_PX = 40;

/** 横スワイプの方向。右へ動かすと前、左へ動かすと次。しきい値未満は無視。 */
export function swipeDirection(deltaX: number): 'prev' | 'next' | null {
  if (Math.abs(deltaX) < SWIPE_THRESHOLD_PX) return null;
  return deltaX > 0 ? 'prev' : 'next';
}

export function clampIndex(index: number, length: number): number {
  return Math.min(Math.max(index, 0), Math.max(length - 1, 0));
}
