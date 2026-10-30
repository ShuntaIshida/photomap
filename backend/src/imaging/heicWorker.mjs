// HEICのデコードとリサイズ用ワーカー。libheif-js(WASM)のデコードは同期処理で重いため、
// メインスレッドのイベントループを止めないようworker_threads上で実行する。
// 1ジョブごとにワーカーを終了する前提（WASMヒープは縮まないので、終了でメモリを確実に返す）。
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

async function run({ input, maxSide, quality, maxPixels }) {
  const libheif = require('libheif-js/wasm-bundle');
  const sharp = require('sharp');

  const decoder = new libheif.HeifDecoder();
  let images;
  try {
    images = decoder.decode(Buffer.from(input));
  } catch {
    return { ok: false, code: 'decode_failed' };
  }
  const image = images?.[0];
  if (!image) return { ok: false, code: 'decode_failed' };

  // libheifは回転(irot)・反転(imir)をデコード時に適用するため、ここで得る幅・高さは表示される向きのもの。
  const width = image.get_width();
  const height = image.get_height();
  // RGBAを確保する前に画素数を確認する（巨大画像でのメモリ不足を避ける）。
  if (width * height > maxPixels) return { ok: false, code: 'too_large' };

  const rgba = new Uint8ClampedArray(width * height * 4);
  const displayed = await new Promise((resolve) => {
    image.display({ data: rgba, width, height }, (result) => resolve(Boolean(result)));
  });
  if (!displayed) return { ok: false, code: 'decode_failed' };

  const out = await sharp(Buffer.from(rgba.buffer), { raw: { width, height, channels: 4 } })
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer({ resolveWithObject: true });
  // sharpのBufferは共有プール上にありtransferできないため、独立したコピーを返す（JPEGなので小さい）。
  const data = new Uint8Array(out.data);
  return { ok: true, data, width: out.info.width, height: out.info.height, sourceWidth: width, sourceHeight: height };
}

run(workerData)
  .then((result) => parentPort.postMessage(result))
  .catch(() => parentPort.postMessage({ ok: false, code: 'decode_failed' }));
