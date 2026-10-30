import { createHash } from 'node:crypto';
import { errors } from '../errors.js';
import type { ImageProcessor } from '../imaging/imageProcessor.js';
import { log } from '../logger.js';
import type { PhotoRecord, PhotoRepository } from '../stores/photoRepository.js';
import type { DriveGateway } from './driveGateway.js';
import { extractExif, type ExifResult } from './exif.js';
import { MAX_ORIGINAL_BYTES, MIME_BY_KIND, sanitizeFilename, sniffImageKind } from './photoFormat.js';
import type { RegionService } from './regions.js';

export const THUMBNAIL_FOLDER_NAME = '_thumbnails';

export interface UploadInput {
  uid: string;
  uploaderName: string;
  slug: string;
  file: Buffer;
  filename: string;
}

export interface PhotoUploadDeps {
  gateway: DriveGateway;
  regions: RegionService;
  photos: PhotoRepository;
  images: ImageProcessor;
  extract?: (buf: Buffer) => Promise<ExifResult>;
}

export class PhotoUploadService {
  private readonly extract: (buf: Buffer) => Promise<ExifResult>;

  constructor(private readonly deps: PhotoUploadDeps) {
    this.extract = deps.extract ?? extractExif;
  }

  async upload(input: UploadInput): Promise<{ photoId: string }> {
    const { gateway, regions, photos, images } = this.deps;
    const { file } = input;

    if (file.length === 0) throw errors.invalidUpload('Empty file');
    if (file.length > MAX_ORIGINAL_BYTES) throw errors.fileTooLarge();
    const kind = sniffImageKind(file);
    if (!kind) throw errors.unsupportedType();

    // 座標・日時は原本のEXIFから読む（画像のデコードとは独立。クライアントの申告値は使わない）。
    // GPSが無い写真はここで弾くので、重い画像処理やDriveへの書き込みは行われない。
    const exif = await this.extract(file);

    // 保存先は地域slugからサーバー側でDriveの直下フォルダーとして解決する（クライアントはIDを指定できない）。
    const { regions: folders } = await regions.list({ fresh: true });
    const region = folders.find((r) => r.slug === input.slug);
    if (!region) throw errors.regionNotFound();

    const hash = createHash('sha256').update(file).digest('hex');
    const photoId = `${region.slug}-${hash.slice(0, 32)}`;
    if (await photos.exists(photoId)) throw errors.duplicatePhoto();

    // 一覧・マーカー用のサムネイル（長辺640pxのJPEG）をサーバーで生成する。デコードに失敗した写真は何も保存しない。
    const thumb = await images.thumbnail(file, kind);

    const originalName = sanitizeFilename(input.filename);
    const uploaded: string[] = [];
    const cleanup = async () => {
      for (const id of uploaded) {
        try {
          await gateway.deleteFile(id);
        } catch {
          log('WARNING', 'failed to clean up Drive file after upload error', { photoId });
        }
      }
    };

    try {
      const thumbFolderId = await gateway.ensureChildFolder(region.driveFolderId, THUMBNAIL_FOLDER_NAME);
      // 保存するファイルは「原本（無変換）」と「サムネイル」の2つだけ。表示用の高解像度ファイルは作らない。
      const driveFileId = await gateway.uploadFile({
        parentId: region.driveFolderId,
        name: `${hash.slice(0, 8)}_${originalName}`,
        mimeType: MIME_BY_KIND[kind],
        data: file,
        appProperties: { photomapPhotoId: photoId, uploaderUid: input.uid },
      });
      uploaded.push(driveFileId);
      const thumbnailDriveFileId = await gateway.uploadFile({
        parentId: thumbFolderId,
        name: `${photoId}.jpg`,
        mimeType: 'image/jpeg',
        data: thumb.data,
        appProperties: { photomapPhotoId: photoId },
      });
      uploaded.push(thumbnailDriveFileId);

      const record: PhotoRecord = {
        regionId: region.slug,
        driveFileId,
        thumbnailDriveFileId,
        originalFilename: originalName,
        mimeType: MIME_BY_KIND[kind],
        latitude: exif.latitude,
        longitude: exif.longitude,
        capturedAt: exif.capturedAt,
        capturedAtTimeZoneKnown: exif.capturedAtTimeZoneKnown,
        uploaderUid: input.uid,
        uploaderName: input.uploaderName,
        width: exif.width,
        height: exif.height,
        sizeBytes: file.length,
        contentHash: hash,
      };
      if ((await photos.create(photoId, record)) === 'exists') throw errors.duplicatePhoto();
    } catch (e) {
      await cleanup();
      throw e;
    }

    log('INFO', 'photo uploaded', { uid: input.uid, region: region.slug, photoId, bytes: file.length });
    return { photoId };
  }
}
