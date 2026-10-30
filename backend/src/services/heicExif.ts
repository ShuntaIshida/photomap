/**
 * HEIC/HEIFコンテナ(ISOBMFF)から Exif メタデータ項目を取り出す。画像のデコードは行わない。
 * exifrがHEICのExifを見つけられない場合の予備の経路（iloc/iinfを自前で辿る）。
 *
 * 返すのはTIFFヘッダ（"II"/"MM"）から始まるバイト列で、そのままexifrに渡せる。
 * 見つからなければnull。壊れた構造は例外ではなくnull（呼び出し側が「解析失敗」と判断する）。
 */

interface Box {
  type: string;
  start: number; // ボックス先頭
  bodyStart: number;
  end: number;
}

function readBox(buf: Buffer, offset: number, limit: number): Box | null {
  if (offset + 8 > limit) return null;
  let size = buf.readUInt32BE(offset);
  const type = buf.toString('latin1', offset + 4, offset + 8);
  let header = 8;
  if (size === 1) {
    if (offset + 16 > limit) return null;
    const big = buf.readBigUInt64BE(offset + 8);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(big);
    header = 16;
  } else if (size === 0) {
    size = limit - offset;
  }
  if (size < header || offset + size > limit) return null;
  return { type, start: offset, bodyStart: offset + header, end: offset + size };
}

function* children(buf: Buffer, from: number, to: number): Generator<Box> {
  let pos = from;
  while (pos < to) {
    const box = readBox(buf, pos, to);
    if (!box) return;
    yield box;
    pos = box.end;
  }
}

function readUInt(buf: Buffer, offset: number, size: number): number | null {
  if (size === 0) return 0;
  if (offset + size > buf.length) return null;
  if (size === 4) return buf.readUInt32BE(offset);
  if (size === 8) {
    const v = buf.readBigUInt64BE(offset);
    return v > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(v);
  }
  if (size === 2) return buf.readUInt16BE(offset);
  return null;
}

export function extractHeicExif(buf: Buffer): Buffer | null {
  const meta = [...children(buf, 0, buf.length)].find((b) => b.type === 'meta');
  if (!meta) return null;
  // metaはFullBox（version+flags の4バイト後に子ボックス）。
  const inner = [...children(buf, meta.bodyStart + 4, meta.end)];

  // 1) iinfから、item_typeが'Exif'の項目IDを探す。
  const iinf = inner.find((b) => b.type === 'iinf');
  if (!iinf) return null;
  const iinfVersion = buf[iinf.bodyStart] ?? 0;
  let p = iinf.bodyStart + 4 + (iinfVersion === 0 ? 2 : 4);
  let exifItemId: number | null = null;
  for (const infe of children(buf, p, iinf.end)) {
    if (infe.type !== 'infe') continue;
    const ver = buf[infe.bodyStart] ?? 0;
    if (ver < 2) continue;
    let q = infe.bodyStart + 4;
    const id = ver === 2 ? readUInt(buf, q, 2) : readUInt(buf, q, 4);
    q += ver === 2 ? 2 : 4;
    q += 2; // item_protection_index
    if (id !== null && buf.toString('latin1', q, q + 4) === 'Exif') {
      exifItemId = id;
      break;
    }
  }
  if (exifItemId === null) return null;

  // 2) ilocから、その項目のデータ位置を得る。
  const iloc = inner.find((b) => b.type === 'iloc');
  if (!iloc) return null;
  const ver = buf[iloc.bodyStart] ?? 0;
  let q = iloc.bodyStart + 4;
  const sizes1 = buf[q++] ?? 0;
  const offsetSize = sizes1 >> 4;
  const lengthSize = sizes1 & 0x0f;
  const sizes2 = buf[q++] ?? 0;
  const baseOffsetSize = sizes2 >> 4;
  const indexSize = ver === 1 || ver === 2 ? sizes2 & 0x0f : 0;
  const itemCount = ver < 2 ? readUInt(buf, q, 2) : readUInt(buf, q, 4);
  q += ver < 2 ? 2 : 4;
  if (itemCount === null || itemCount > 65535) return null;

  for (let i = 0; i < itemCount; i += 1) {
    const id = ver < 2 ? readUInt(buf, q, 2) : readUInt(buf, q, 4);
    q += ver < 2 ? 2 : 4;
    let constructionMethod = 0;
    if (ver === 1 || ver === 2) {
      constructionMethod = (readUInt(buf, q, 2) ?? 0) & 0x0f;
      q += 2;
    }
    q += 2; // data_reference_index
    const baseOffset = readUInt(buf, q, baseOffsetSize);
    q += baseOffsetSize;
    const extentCount = readUInt(buf, q, 2);
    q += 2;
    if (baseOffset === null || extentCount === null || extentCount > 64) return null;

    const extents: Array<{ offset: number; length: number }> = [];
    for (let e = 0; e < extentCount; e += 1) {
      if (indexSize) q += indexSize;
      const off = readUInt(buf, q, offsetSize);
      q += offsetSize;
      const len = readUInt(buf, q, lengthSize);
      q += lengthSize;
      if (off === null || len === null) return null;
      extents.push({ offset: off, length: len });
    }

    if (id !== exifItemId) continue;
    // construction_method 0 = ファイル先頭からのオフセット（iPhoneのHEICはこれ）。
    if (constructionMethod !== 0 || extents.length !== 1) return null;
    const ext = extents[0]!;
    const begin = baseOffset + ext.offset;
    if (begin + ext.length > buf.length || ext.length < 8) return null;
    const data = buf.subarray(begin, begin + ext.length);
    // Exifアイテムは先頭4バイトがTIFFヘッダまでのオフセット（通常 "Exif\0\0" の長さ）。
    const skip = data.readUInt32BE(0);
    const tiff = data.subarray(4 + skip);
    const head = tiff.toString('latin1', 0, 2);
    return head === 'II' || head === 'MM' ? tiff : null;
  }
  return null;
}
