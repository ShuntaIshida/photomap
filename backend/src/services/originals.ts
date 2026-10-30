import type { Readable } from 'node:stream';
import { errors } from '../errors.js';
import type { ImageProcessor } from '../imaging/imageProcessor.js';
import type { PhotoRepository } from '../stores/photoRepository.js';
import type { DriveGateway } from './driveGateway.js';
import { MAX_ORIGINAL_BYTES, sniffImageKind, type ImageKind } from './photoFormat.js';

export type OriginalResult =
  | { kind: 'stream'; contentType: 'image/jpeg'; stream: Readable; contentLength: number | null }
  | { kind: 'buffer'; contentType: 'image/jpeg'; data: Buffer };

export interface OriginalServiceOptions {
  /** 変換済み画像をメモリに残す上限（バイト）。永続保存はしない。 */
  cacheBytes?: number;
}

const KIND_BY_MIME: Record<string, ImageKind> = { 'image/jpeg': 'jpeg', 'image/heic': 'heic', 'image/heif': 'heic' };
const CACHE_ITEM_MAX = 12 * 1024 * 1024;

async function readLimited(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) {
      stream.destroy();
      throw errors.fileTooLarge();
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * 全画面ビューア用の原本配信。Firestoreに登録された写真のDriveファイルだけを、このAPI経由で返す。
 * - JPEG: Driveの原本を無加工のまま中継する（リサイズしない）。
 * - HEIC: 原本からJPEGへ都度変換して返す。変換結果はDriveに保存せず、メモリ上の小さなLRUと、同時リクエストの合流でCPU負荷を抑える。
 */
export class OriginalService {
  private readonly cache = new Map<string, Buffer>();
  private cacheSize = 0;
  private readonly inflight = new Map<string, Promise<Buffer>>();
  private readonly cacheBytes: number;

  constructor(
    private readonly deps: { photos: PhotoRepository; gateway: DriveGateway; images: ImageProcessor },
    options: OriginalServiceOptions = {},
  ) {
    this.cacheBytes = options.cacheBytes ?? 24 * 1024 * 1024;
  }

  async open(photoId: string): Promise<OriginalResult> {
    const info = await this.deps.photos.getOriginalInfo(photoId);
    if (!info) throw errors.photoNotFound();

    const declared = info.mimeType ? KIND_BY_MIME[info.mimeType] : undefined;
    if (info.mimeType && !declared) throw errors.originalUnavailable();
    if (info.sizeBytes !== null && info.sizeBytes > MAX_ORIGINAL_BYTES) throw errors.originalUnavailable();

    // mimeTypeが記録されていない古いデータは、先頭バイトで形式を判定する。
    let kind = declared;
    let head: Readable | null = null;
    if (!kind) {
      const stream = await this.deps.gateway.openFile(info.driveFileId);
      const data = await readLimited(stream, MAX_ORIGINAL_BYTES);
      kind = sniffImageKind(data) ?? undefined;
      if (!kind) throw errors.originalUnavailable();
      return kind === 'jpeg' ? { kind: 'buffer', contentType: 'image/jpeg', data } : { kind: 'buffer', contentType: 'image/jpeg', data: await this.convert(photoId, data) };
    }

    if (kind === 'jpeg') {
      head = await this.deps.gateway.openFile(info.driveFileId);
      return { kind: 'stream', contentType: 'image/jpeg', stream: head, contentLength: info.sizeBytes };
    }
    return { kind: 'buffer', contentType: 'image/jpeg', data: await this.convertFromDrive(photoId, info.driveFileId) };
  }

  private async convertFromDrive(photoId: string, driveFileId: string): Promise<Buffer> {
    const cached = this.cache.get(photoId);
    if (cached) {
      // 最近使ったものを末尾へ（LRU）。
      this.cache.delete(photoId);
      this.cache.set(photoId, cached);
      return cached;
    }
    const pending = this.inflight.get(photoId);
    if (pending) return pending;

    const job = (async () => {
      const original = await readLimited(await this.deps.gateway.openFile(driveFileId), MAX_ORIGINAL_BYTES);
      return this.convert(photoId, original);
    })().finally(() => this.inflight.delete(photoId));
    this.inflight.set(photoId, job);
    return job;
  }

  private async convert(photoId: string, original: Buffer): Promise<Buffer> {
    const { data } = await this.deps.images.displayFromHeic(original);
    this.remember(photoId, data);
    return data;
  }

  private remember(photoId: string, data: Buffer) {
    if (data.length > CACHE_ITEM_MAX || data.length > this.cacheBytes) return;
    this.cache.set(photoId, data);
    this.cacheSize += data.length;
    for (const [key, value] of this.cache) {
      if (this.cacheSize <= this.cacheBytes) break;
      this.cache.delete(key);
      this.cacheSize -= value.length;
    }
  }
}
