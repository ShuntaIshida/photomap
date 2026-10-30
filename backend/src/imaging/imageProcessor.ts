import sharp from 'sharp';
import { errors } from '../errors.js';
import type { ImageKind } from '../services/photoFormat.js';
import { HeicWorkerPool, type HeicConverter } from './heicPool.js';

export const THUMBNAIL_MAX_SIDE = 640;
export const THUMBNAIL_QUALITY = 82;
/** HEICの表示用に生成するJPEGの長辺。HEICはブラウザで直接表示できないため、ここで変換して配信する。 */
export const DISPLAY_MAX_SIDE = 2560;
export const DISPLAY_QUALITY = 85;

// JPEGの最大画素数（デコード時のメモリ上限）。iPhoneの48MPを許容する。
const MAX_JPEG_PIXELS = 100_000_000;

export interface ProcessedImage {
  data: Buffer;
  width: number;
  height: number;
}

export interface ImageProcessor {
  /** 一覧・マーカー用の長辺640pxのJPEG。EXIFの向きを反映し、メタデータ（GPS等）は含めない。 */
  thumbnail(original: Buffer, kind: ImageKind): Promise<ProcessedImage>;
  /** HEICをブラウザで表示できるJPEGにする。EXIFは含めない。 */
  displayFromHeic(original: Buffer): Promise<ProcessedImage>;
}

// 1リクエストでスレッドとキャッシュを使いすぎないようにする（Cloud Runの小さなインスタンス向け）。
sharp.cache({ memory: 48, files: 0, items: 20 });
sharp.concurrency(2);

export class SharpImageProcessor implements ImageProcessor {
  constructor(private readonly heic: HeicConverter = new HeicWorkerPool()) {}

  async thumbnail(original: Buffer, kind: ImageKind): Promise<ProcessedImage> {
    if (kind === 'heic') {
      const out = await this.heic.toJpeg(original, { maxSide: THUMBNAIL_MAX_SIDE, quality: THUMBNAIL_QUALITY });
      return out;
    }
    try {
      const { data, info } = await sharp(original, { failOn: 'error', limitInputPixels: MAX_JPEG_PIXELS })
        // rotate()はEXIFのOrientationを画素に反映し、メタデータは出力に残さない。
        .rotate()
        .resize({ width: THUMBNAIL_MAX_SIDE, height: THUMBNAIL_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: THUMBNAIL_QUALITY })
        .toBuffer({ resolveWithObject: true });
      return { data, width: info.width, height: info.height };
    } catch (e) {
      if (/pixel limit/i.test((e as Error).message)) throw errors.imageTooLarge();
      throw errors.imageDecodeFailed();
    }
  }

  displayFromHeic(original: Buffer): Promise<ProcessedImage> {
    return this.heic.toJpeg(original, { maxSide: DISPLAY_MAX_SIDE, quality: DISPLAY_QUALITY });
  }
}
