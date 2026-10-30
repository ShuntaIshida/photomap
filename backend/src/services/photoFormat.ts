// クライアント申告のContent-Typeは信用せず、先頭バイトで実形式を判定する。

export type ImageKind = 'jpeg' | 'heic';

export const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024;
export const MAX_THUMBNAIL_BYTES = 1024 * 1024;

export const MIME_BY_KIND: Record<ImageKind, string> = {
  jpeg: 'image/jpeg',
  heic: 'image/heic',
};

// HEIC/HEIFのftypブランド（HEVC系と汎用HEIF）。AVIF等は対象外。
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);

export function sniffImageKind(buf: Uint8Array): ImageKind | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 12) {
    const isFtyp = buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70;
    if (isFtyp) {
      const brand = String.fromCharCode(buf[8]!, buf[9]!, buf[10]!, buf[11]!);
      if (HEIC_BRANDS.has(brand)) return 'heic';
    }
  }
  return null;
}

/** ファイル名からパス区切り・制御文字を除き、Drive上の名前として安全な形にする。 */
export function sanitizeFilename(name: string, fallback = 'photo'): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  const limited = [...cleaned].slice(0, 120).join('');
  return limited || fallback;
}
