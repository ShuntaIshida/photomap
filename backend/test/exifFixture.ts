// EXIF付きの最小JPEGをテスト内で組み立てる（外部の画像ファイルやライブラリに依存しない）。

interface Entry {
  tag: number;
  type: 2 | 3 | 4 | 5; // ASCII, SHORT, LONG, RATIONAL
  count: number;
  value: Buffer;
}

const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const ascii = (s: string): Entry['value'] => Buffer.from(`${s}\0`, 'latin1');
const rational = (num: number, den: number) => Buffer.concat([u32(num), u32(den)]);

const extraSize = (entries: Entry[]) => entries.reduce((n, e) => n + (e.value.length > 4 ? e.value.length + (e.value.length % 2) : 0), 0);
const ifdSize = (entries: Entry[]) => 2 + entries.length * 12 + 4 + extraSize(entries);

function buildIfd(entries: Entry[], offset: number): Buffer {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  const head: Buffer[] = [u16(sorted.length)];
  const extra: Buffer[] = [];
  let extraOffset = offset + 2 + sorted.length * 12 + 4;
  for (const e of sorted) {
    let value: Buffer;
    if (e.value.length <= 4) {
      value = Buffer.concat([e.value, Buffer.alloc(4 - e.value.length)]);
    } else {
      value = u32(extraOffset);
      const padded = e.value.length % 2 ? Buffer.concat([e.value, Buffer.alloc(1)]) : e.value;
      extra.push(padded);
      extraOffset += padded.length;
    }
    head.push(u16(e.tag), u16(e.type), u32(e.count), value);
  }
  head.push(u32(0));
  return Buffer.concat([...head, ...extra]);
}

function dms(value: number): Buffer {
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = (minFloat - min) * 60;
  return Buffer.concat([rational(deg, 1), rational(min, 1), rational(Math.round(sec * 10000), 10000)]);
}

export interface JpegOptions {
  lat?: number;
  lng?: number;
  /** "YYYY:MM:DD HH:MM:SS" */
  date?: string;
  /** "+09:00" など */
  offset?: string;
  width?: number;
  height?: number;
}

export function makeJpegWithExif({ lat, lng, date, offset, width, height }: JpegOptions = {}): Buffer {
  const exifEntries: Entry[] = [];
  if (date) exifEntries.push({ tag: 0x9003, type: 2, count: date.length + 1, value: ascii(date) });
  if (offset) exifEntries.push({ tag: 0x9011, type: 2, count: offset.length + 1, value: ascii(offset) });
  if (width) exifEntries.push({ tag: 0xa002, type: 4, count: 1, value: u32(width) });
  if (height) exifEntries.push({ tag: 0xa003, type: 4, count: 1, value: u32(height) });

  const gpsEntries: Entry[] = [];
  if (lat !== undefined && lng !== undefined) {
    gpsEntries.push(
      { tag: 0x0001, type: 2, count: 2, value: ascii(lat >= 0 ? 'N' : 'S') },
      { tag: 0x0002, type: 5, count: 3, value: dms(lat) },
      { tag: 0x0003, type: 2, count: 2, value: ascii(lng >= 0 ? 'E' : 'W') },
      { tag: 0x0004, type: 5, count: 3, value: dms(lng) },
    );
  }

  const ifd0Placeholder: Entry[] = [];
  if (exifEntries.length) ifd0Placeholder.push({ tag: 0x8769, type: 4, count: 1, value: u32(0) });
  if (gpsEntries.length) ifd0Placeholder.push({ tag: 0x8825, type: 4, count: 1, value: u32(0) });

  const ifd0Off = 8;
  const exifOff = ifd0Off + ifdSize(ifd0Placeholder);
  const gpsOff = exifOff + (exifEntries.length ? ifdSize(exifEntries) : 0);

  const ifd0Entries: Entry[] = [];
  if (exifEntries.length) ifd0Entries.push({ tag: 0x8769, type: 4, count: 1, value: u32(exifOff) });
  if (gpsEntries.length) ifd0Entries.push({ tag: 0x8825, type: 4, count: 1, value: u32(gpsOff) });

  const tiff = Buffer.concat([
    Buffer.from('II', 'latin1'),
    u16(42),
    u32(ifd0Off),
    buildIfd(ifd0Entries, ifd0Off),
    exifEntries.length ? buildIfd(exifEntries, exifOff) : Buffer.alloc(0),
    gpsEntries.length ? buildIfd(gpsEntries, gpsOff) : Buffer.alloc(0),
  ]);

  const app1Body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1Len = Buffer.alloc(2);
  app1Len.writeUInt16BE(app1Body.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), app1Len, app1Body, Buffer.from([0xff, 0xd9])]);
}

/** ftypブランドだけを持つ最小のHEIC風バッファ（形式判定のテスト用）。 */
export function makeHeicLike(brand = 'heic'): Buffer {
  return Buffer.concat([u32BE(24), Buffer.from(`ftyp${brand}`, 'latin1'), Buffer.alloc(12)]);
}

function u32BE(n: number) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}
