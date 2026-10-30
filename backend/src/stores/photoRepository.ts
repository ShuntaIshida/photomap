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

/** 名前変更・削除の権限判定と対象特定に必要な情報。 */
export interface PhotoManageInfo {
  /** 投稿者UID。記録の無い過去の写真はnull（管理者のみ操作可）。 */
  uploaderUid: string | null;
  driveFileId: string | null;
  thumbnailDriveFileId: string | null;
}

export interface PhotoRepository {
  exists(id: string): Promise<boolean>;
  /** 既に同じIDがあれば何も書かず 'exists' を返す（原子的）。 */
  create(id: string, record: PhotoRecord): Promise<'created' | 'exists'>;
  getThumbnailFileId(id: string): Promise<string | null>;
  getOriginalInfo(id: string): Promise<PhotoOriginalInfo | null>;
  getManageInfo(id: string): Promise<PhotoManageInfo | null>;
  /** 表示タイトルだけを更新する（originalFilenameとDriveのファイル名は変えない）。 */
  updateTitle(id: string, title: string): Promise<void>;
  delete(id: string): Promise<void>;
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

  async getManageInfo(id: string): Promise<PhotoManageInfo | null> {
    const snap = await this.col.doc(id).get();
    const d = snap.data();
    if (!snap.exists || !d) return null;
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
    return { uploaderUid: str(d.uploaderUid), driveFileId: str(d.driveFileId), thumbnailDriveFileId: str(d.thumbnailDriveFileId) };
  }

  async updateTitle(id: string, title: string): Promise<void> {
    await this.col.doc(id).update({ title });
  }

  async delete(id: string): Promise<void> {
    await this.col.doc(id).delete();
  }
}

export class MemoryPhotoRepository implements PhotoRepository {
  readonly records = new Map<string, PhotoRecord>();
  readonly titles = new Map<string, string>();
  /** テスト用: uploaderUidを持たない過去データを再現する。 */
  readonly legacyNoUploader = new Set<string>();
  failNextCreate = false;
  failNextUpdate = false;
  failNextDelete = false;

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

  async getManageInfo(id: string): Promise<PhotoManageInfo | null> {
    const r = this.records.get(id);
    if (!r) return null;
    return {
      uploaderUid: this.legacyNoUploader.has(id) ? null : r.uploaderUid || null,
      driveFileId: r.driveFileId,
      thumbnailDriveFileId: r.thumbnailDriveFileId,
    };
  }

  async updateTitle(id: string, title: string) {
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new Error('firestore unavailable');
    }
    this.titles.set(id, title);
  }

  async delete(id: string) {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error('firestore unavailable');
    }
    this.records.delete(id);
    this.titles.delete(id);
  }
}
