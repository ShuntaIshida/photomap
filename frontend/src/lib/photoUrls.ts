import { API_BASE } from '../data';
import type { Photo } from '../data';

/**
 * サムネイルのURL。Driveのファイルは公開せず、Cloud Runが登録済みの写真だけを代理配信する。
 * サムネイル未登録の写真はnull。
 */
export function thumbnailUrl(photo: Pick<Photo, 'id' | 'thumbnailDriveFileId'>): string | null {
  return photo.thumbnailDriveFileId && API_BASE ? `${API_BASE}/photos/${encodeURIComponent(photo.id)}/thumbnail` : null;
}

/** 全画面ビューア用の原本。JPEGは原本、HEICはCloud Runが変換した表示用JPEG。 */
export function originalUrl(photo: Pick<Photo, 'id'>): string | null {
  return API_BASE ? `${API_BASE}/photos/${encodeURIComponent(photo.id)}/original` : null;
}
