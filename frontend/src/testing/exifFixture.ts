// テスト用: GPS付きの最小JPEGを組み立てる（外部の画像ファイルやライブラリに依存しない）。

interface Entry {
  tag: number;
  type: 2 | 4 | 5; // ASCII, LONG, RATIONAL
  count: number;
  value: number[];
}

const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0)).concat(0);
const rational = (num: number, den: number) => [...le32(num), ...le32(den)];

const extraSize = (es: Entry[]) => es.reduce((n, e) => n + (e.value.length > 4 ? e.value.length + (e.value.length % 2) : 0), 0);
const ifdSize = (es: Entry[]) => 2 + es.length * 12 + 4 + extraSize(es);

function buildIfd(entries: Entry[], offset: number): number[] {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  const out: number[] = [...le16(sorted.length)];
  const extra: number[] = [];
  let extraOffset = offset + 2 + sorted.length * 12 + 4;
  for (const e of sorted) {
    let value: number[];
    if (e.value.length <= 4) {
      value = [...e.value, ...Array(4 - e.value.length).fill(0)];
    } else {
      value = le32(extraOffset);
      const padded = e.value.length % 2 ? [...e.value, 0] : e.value;
      extra.push(...padded);
      extraOffset += padded.length;
    }
    out.push(...le16(e.tag), ...le16(e.type), ...le32(e.count), ...value);
  }
  out.push(...le32(0), ...extra);
  return out;
}

function dms(value: number): number[] {
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = (minFloat - min) * 60;
  return [...rational(deg, 1), ...rational(min, 1), ...rational(Math.round(sec * 10000), 10000)];
}

export function makeJpegWithGps(lat?: number, lng?: number): Uint8Array {
  const gps: Entry[] = [];
  if (lat !== undefined && lng !== undefined) {
    gps.push(
      { tag: 1, type: 2, count: 2, value: ascii(lat >= 0 ? 'N' : 'S') },
      { tag: 2, type: 5, count: 3, value: dms(lat) },
      { tag: 3, type: 2, count: 2, value: ascii(lng >= 0 ? 'E' : 'W') },
      { tag: 4, type: 5, count: 3, value: dms(lng) },
    );
  }
  const ifd0Off = 8;
  const gpsOff = ifd0Off + ifdSize(gps.length ? [{ tag: 0x8825, type: 4, count: 1, value: le32(0) }] : []);
  const ifd0: Entry[] = gps.length ? [{ tag: 0x8825, type: 4, count: 1, value: le32(gpsOff) }] : [];
  const tiff = [0x49, 0x49, ...le16(42), ...le32(ifd0Off), ...buildIfd(ifd0, ifd0Off), ...(gps.length ? buildIfd(gps, gpsOff) : [])];
  const body = [...ascii('Exif').slice(0, 4), 0, 0, ...tiff];
  const len = body.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, (len >> 8) & 0xff, len & 0xff, ...body, 0xff, 0xd9]);
}

export function makeHeicLike(brand = 'heic'): Uint8Array {
  return new Uint8Array([0, 0, 0, 24, ...[...`ftyp${brand}`].map((c) => c.charCodeAt(0)), ...Array(12).fill(0)]);
}
