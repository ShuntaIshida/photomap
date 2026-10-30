import type { ImageKind } from './photoFile';

const MAX_SIDE = 640;
const QUALITY = 0.82;

async function decode(file: Blob, kind: ImageKind): Promise<ImageBitmap> {
  if (kind === 'heic') {
    // Safariなどネイティブ対応のブラウザはそのまま復号する。
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // 非対応ブラウザ（Chrome等）はWASMで一度JPEGへ変換する。重いので使うときだけ読み込む。
      const { default: heic2any } = await import('heic2any');
      const converted = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.85 });
      return createImageBitmap(Array.isArray(converted) ? converted[0]! : converted);
    }
  }
  // EXIFの向きを反映して復号する。
  return createImageBitmap(file, { imageOrientation: 'from-image' });
}

/**
 * ブラウザで表示できる一覧用JPEG（長辺640px）を作る。HEICもここでJPEGに変換される。
 * 原本はそのまま保存し、この派生物だけを一覧・プレビュー表示に使う。
 */
export async function createThumbnail(file: Blob, kind: ImageKind): Promise<Blob> {
  const bitmap = await decode(file, kind);
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unavailable');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
    if (!blob) throw new Error('thumbnail encoding failed');
    return blob;
  } finally {
    bitmap.close();
  }
}
