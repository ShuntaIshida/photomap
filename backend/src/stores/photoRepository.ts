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

export interface PhotoRepository {
  exists(id: string): Promise<boolean>;
  /** 既に同じIDがあれば何も書かず 'exists' を返す（原子的）。 */
  create(id: string, record: PhotoRecord): Promise<'created' | 'exists'>;
  getThumbnailFileId(id: string): Promise<string | null>;
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
}
