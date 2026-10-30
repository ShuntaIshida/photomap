import { FieldValue, getFirestore } from 'firebase-admin/firestore';

/** photos/{id} に保存する内容。uploadedAt/hasGps/locationSourceは保存時にサーバーが付与する。 */
export interface PhotoRecord {
  regionId: string;
  driveFileId: string;
  thumbnailDriveFileId: string;
  originalFilename: string;
  mimeType: string;
  latitude: number;
  longitude: number;
  capturedAt: Date | null;
  capturedAtTimeZoneKnown: boolean;
  uploaderUid: string;
  uploaderName: string;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  contentHash: string;
}

/** 原本配信に必要な最小限の情報。Firestoreに登録済みの写真からしか得られない。 */
export interface PhotoOriginalInfo {
  driveFileId: string;
  /** 保存時にサーバーが記録した実形式（image/jpeg | image/heic）。無い古いデータはnull。 */
  mimeType: string | null;
  sizeBytes: number | null;
}

export interface PhotoRepository {
  exists(id: string): Promise<boolean>;
  /** 既に同じIDがあれば何も書かず 'exists' を返す（原子的）。 */
  create(id: string, record: PhotoRecord): Promise<'created' | 'exists'>;
  getThumbnailFileId(id: string): Promise<string | null>;
  getOriginalInfo(id: string): Promise<PhotoOriginalInfo | null>;
}

const ALREADY_EXISTS = 6;

export class FirestorePhotoRepository implements PhotoRepository {
  private get col() {
    return getFirestore().collection('photos');
  }

  async exists(id: string) {
    return (await this.col.doc(id).get()).exists;
  }

  async create(id: string, record: PhotoRecord): Promise<'created' | 'exists'> {
    try {
      await this.col.doc(id).create({
        ...record,
        hasGps: true,
        locationSource: 'exif',
        uploadedAt: FieldValue.serverTimestamp(),
      });
      return 'created';
    } catch (e) {
      if ((e as { code?: number }).code === ALREADY_EXISTS) return 'exists';
      throw e;
    }
  }

  async getThumbnailFileId(id: string): Promise<string | null> {
    const snap = await this.col.doc(id).get();
    const v = snap.data()?.thumbnailDriveFileId;
    return typeof v === 'string' && v ? v : null;
  }

  async getOriginalInfo(id: string): Promise<PhotoOriginalInfo | null> {
    const d = (await this.col.doc(id).get()).data();
    if (!d || typeof d.driveFileId !== 'string' || !d.driveFileId) return null;
    return {
      driveFileId: d.driveFileId,
      mimeType: typeof d.mimeType === 'string' ? d.mimeType : null,
      sizeBytes: typeof d.sizeBytes === 'number' ? d.sizeBytes : null,
    };
  }
}

export class MemoryPhotoRepository implements PhotoRepository {
  readonly records = new Map<string, PhotoRecord>();
  failNextCreate = false;

  async exists(id: string) {
    return this.records.has(id);
  }

  async create(id: string, record: PhotoRecord) {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error('firestore unavailable');
    }
    if (this.records.has(id)) return 'exists' as const;
    this.records.set(id, record);
    return 'created' as const;
  }

  async getThumbnailFileId(id: string) {
    return this.records.get(id)?.thumbnailDriveFileId ?? null;
  }

  /** テスト用: 旧データ（mimeTypeなし）などを直接登録する。 */
  readonly legacy = new Map<string, PhotoOriginalInfo>();

  async getOriginalInfo(id: string): Promise<PhotoOriginalInfo | null> {
    const legacy = this.legacy.get(id);
    if (legacy) return legacy;
    const r = this.records.get(id);
    return r ? { driveFileId: r.driveFileId, mimeType: r.mimeType, sizeBytes: r.sizeBytes } : null;
  }
}
