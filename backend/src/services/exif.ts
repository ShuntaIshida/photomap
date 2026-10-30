import exifr from 'exifr';
import { errors } from '../errors.js';

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

/** 原本のEXIFを読む。GPSが無い・不正な場合は no_gps で失敗する。 */
export async function extractExif(buf: Buffer): Promise<ExifResult> {
  let gps: { latitude?: number; longitude?: number } | undefined;
  let tags: Record<string, unknown> | undefined;
  try {
    gps = await exifr.gps(buf);
    // 日時は文字列のまま取得し、タイムゾーンを自前で解釈する（環境のTZに依存させない）。
    tags = (await exifr.parse(buf, {
      pick: ['DateTimeOriginal', 'OffsetTimeOriginal', 'CreateDate', 'ExifImageWidth', 'ExifImageHeight', 'ImageWidth', 'ImageHeight'],
      reviveValues: false,
    })) as Record<string, unknown> | undefined;
  } catch {
    // 壊れたEXIFはGPSなしとして扱う。
  }
  if (!gps || !isValidGps(gps.latitude, gps.longitude)) throw errors.noGps();

  const parsed = parseExifDate(tags?.DateTimeOriginal ?? tags?.CreateDate, tags?.OffsetTimeOriginal);
  return {
    latitude: gps.latitude as number,
    longitude: gps.longitude as number,
    capturedAt: parsed?.date ?? null,
    capturedAtTimeZoneKnown: parsed?.timeZoneKnown ?? false,
    width: num(tags?.ExifImageWidth) ?? num(tags?.ImageWidth),
    height: num(tags?.ExifImageHeight) ?? num(tags?.ImageHeight),
  };
}
