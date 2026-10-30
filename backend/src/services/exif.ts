import exifr from 'exifr';
import { errors } from '../errors.js';
import { extractHeicExif } from './heicExif.js';
import { sniffImageKind } from './photoFormat.js';

export interface ExifResult {
  latitude: number;
  longitude: number;
  capturedAt: Date | null;
  /** EXIFにタイムゾーン情報（OffsetTimeOriginal）があったか。無い場合のcapturedAtはJST仮定の推定値。 */
  capturedAtTimeZoneKnown: boolean;
  width: number | null;
  height: number | null;
}

// 撮影現場（秋田県）の想定。オフセットが無いEXIF日時はこの時刻帯として解釈する。
const ASSUMED_OFFSET = '+09:00';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** GPSとして採用できる値か（範囲内・非数でない・(0,0)の無効値でない）。 */
export function isValidGps(lat: unknown, lng: unknown): boolean {
  const la = num(lat);
  const lo = num(lng);
  if (la === null || lo === null) return false;
  if (la < -90 || la > 90 || lo < -180 || lo > 180) return false;
  return !(la === 0 && lo === 0);
}

/** "YYYY:MM:DD HH:MM:SS" と "+09:00" 形式のオフセットからDateを作る。 */
export function parseExifDate(
  raw: unknown,
  offset: unknown,
): { date: Date; timeZoneKnown: boolean } | null {
  if (typeof raw !== 'string') return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim());
  if (!m) return null;
  const known = typeof offset === 'string' && /^[+-]\d{2}:\d{2}$/.test(offset.trim());
  const off = known ? (offset as string).trim() : ASSUMED_OFFSET;
  const date = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${off}`);
  if (Number.isNaN(date.getTime())) return null;
  // 0000:00:00 等の無効値を弾く。
  if (date.getUTCFullYear() < 1990) return null;
  return { date, timeZoneKnown: known };
}

const PICK = ['DateTimeOriginal', 'OffsetTimeOriginal', 'CreateDate', 'ExifImageWidth', 'ExifImageHeight', 'ImageWidth', 'ImageHeight', 'Make', 'Model'];

type Tags = Record<string, unknown>;
interface Parsed {
  gps: { latitude?: number; longitude?: number } | undefined;
  tags: Tags | undefined;
}

/** exifrでEXIFを読む。解析自体が失敗したら例外（「GPSなし」とは区別する）。 */
async function parseWithExifr(source: Buffer | Uint8Array): Promise<Parsed> {
  const gps = await exifr.gps(source);
  // 日時は文字列のまま取得し、タイムゾーンを自前で解釈する（環境のTZに依存させない）。
  const tags = (await exifr.parse(source, { pick: PICK, reviveValues: false })) as Tags | undefined;
  return { gps, tags };
}

/**
 * 原本のEXIFを読む。画像のデコードとは独立した処理。
 * - 位置情報がある: 結果を返す
 * - EXIFは読めたが位置情報が無い・不正（範囲外、(0,0)）: no_gps
 * - EXIFの解析自体が失敗した: exif_parse_failed（GPSが無いこととは区別する）
 */
export async function extractExif(buf: Buffer): Promise<ExifResult> {
  let parsed: Parsed | undefined;
  let failed = false;
  try {
    parsed = await parseWithExifr(buf);
  } catch {
    failed = true;
  }

  // HEICでexifrが何も見つけられないときは、コンテナからExif項目を直接取り出して再試行する。
  const noInfo = failed || (!parsed?.gps && !parsed?.tags);
  if (noInfo && sniffImageKind(buf) === 'heic') {
    const tiff = extractHeicExif(buf);
    if (tiff) {
      try {
        parsed = await parseWithExifr(tiff);
        failed = false;
      } catch {
        failed = true;
      }
    }
  }

  if (failed && !parsed) throw errors.exifParseFailed();
  const { gps, tags } = parsed ?? { gps: undefined, tags: undefined };
  if (!gps || !isValidGps(gps.latitude, gps.longitude)) throw errors.noGps();

  const captured = parseExifDate(tags?.DateTimeOriginal ?? tags?.CreateDate, tags?.OffsetTimeOriginal);
  return {
    latitude: gps.latitude as number,
    longitude: gps.longitude as number,
    capturedAt: captured?.date ?? null,
    capturedAtTimeZoneKnown: captured?.timeZoneKnown ?? false,
    width: num(tags?.ExifImageWidth) ?? num(tags?.ImageWidth),
    height: num(tags?.ExifImageHeight) ?? num(tags?.ImageHeight),
  };
}
