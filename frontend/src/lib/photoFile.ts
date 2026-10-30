import exifr from 'exifr';

export const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024;

export type ImageKind = 'jpeg' | 'heic';

// HEIC/HEIFのftypブランド。バックエンドの判定と揃える。
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);

/** 拡張子やMIMEではなく先頭バイトで形式を判定する（iOSはHEICのtypeが空になることがある）。 */
export function sniffImageKind(buf: Uint8Array): ImageKind | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = String.fromCharCode(buf[8]!, buf[9]!, buf[10]!, buf[11]!);
    if (HEIC_BRANDS.has(brand)) return 'heic';
  }
  return null;
}

export type RejectCode = 'empty' | 'too_large' | 'unsupported' | 'no_gps';

// serverCheck: ブラウザではGPSを確認できなかったため、サーバーの判定に任せる（HEICや解析失敗）。
export type Inspection =
  | { ok: true; kind: ImageKind; latitude: number; longitude: number; serverCheck: false }
  | { ok: true; kind: ImageKind; serverCheck: true }
  | { ok: false; code: RejectCode; reason: string };

export const REJECT_MESSAGES: Record<RejectCode, string> = {
  empty: 'ファイルが空です',
  too_large: 'ファイルサイズが大きすぎます（上限20MB）',
  unsupported: 'JPEGまたはHEIC形式の写真のみアップロードできます',
  no_gps: 'GPS位置情報がないためアップロードできません（今回は対象外です）',
};

const reject = (code: RejectCode, reason: string = REJECT_MESSAGES[code]): Inspection => ({ ok: false, code, reason });

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

/** 座標として採用できるか。(0,0)は位置情報なしのカメラが書く値なので除外する。 */
export function isValidGps(lat: unknown, lng: unknown): boolean {
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  return !(lat === 0 && lng === 0);
}

/** 送信前の確認。サーバーでも同じ検証を行う（これはUX向けの事前チェック）。 */
export async function inspectPhoto(file: Blob): Promise<Inspection> {
  if (file.size === 0) return reject('empty');
  if (file.size > MAX_ORIGINAL_BYTES) return reject('too_large', `ファイルサイズが大きすぎます（${mb(file.size)}。上限${mb(MAX_ORIGINAL_BYTES)}）`);
  // 先頭だけで形式を判定し、EXIFは必要な範囲だけ読む（大量選択時に全ファイルをメモリへ載せない）。
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const kind = sniffImageKind(bytes);
  if (!kind) return reject('unsupported');

  let gps: { latitude?: number; longitude?: number } | undefined;
  try {
    try {
      gps = await exifr.gps(file);
    } catch {
      // Blobを直接読めない環境では、全体を読み込んで解析し直す。
      gps = await exifr.gps(new Uint8Array(await file.arrayBuffer()));
    }
  } catch {
    // EXIFを読めないことはGPSが無いこととは別。サーバー（原本のEXIFを独立に解析）が判定する。
    return { ok: true, kind, serverCheck: true };
  }
  if (gps && isValidGps(gps.latitude, gps.longitude)) {
    return { ok: true, kind, latitude: gps.latitude as number, longitude: gps.longitude as number, serverCheck: false };
  }
  // HEICはブラウザ側の解析が不完全なことがあるため、拒否せずサーバーに任せる。
  if (kind === 'heic') return { ok: true, kind, serverCheck: true };
  return reject('no_gps');
}
