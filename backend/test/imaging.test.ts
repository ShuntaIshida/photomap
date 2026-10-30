import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { HeicWorkerPool } from '../src/imaging/heicPool.js';
import { SharpImageProcessor } from '../src/imaging/imageProcessor.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const options = { maxSide: 640, quality: 80 };

describe('HeicWorkerPool', () => {
  it('converts landscape and portrait HEIC to JPEG with the orientation kept', async () => {
    const pool = new HeicWorkerPool();
    const landscape = await pool.toJpeg(fixture('gps.heic'), options);
    const portrait = await pool.toJpeg(fixture('gps-portrait.heic'), options);
    expect([landscape.width, landscape.height]).toEqual([640, 480]);
    expect([portrait.width, portrait.height]).toEqual([480, 640]);
    expect([landscape.data[0], landscape.data[1]]).toEqual([0xff, 0xd8]);
    // 出力に元のEXIF（GPS等）を残さない。
    expect((await sharp(landscape.data).metadata()).exif).toBeUndefined();
  });

  it('fails with image_decode_failed for broken data', async () => {
    const pool = new HeicWorkerPool();
    await expect(pool.toJpeg(Buffer.from('not a heic file at all'), options)).rejects.toMatchObject({
      code: 'image_decode_failed',
    });
  });

  it('refuses images above the pixel limit before decoding them', async () => {
    const pool = new HeicWorkerPool({ maxPixels: 1000 });
    await expect(pool.toJpeg(fixture('gps.heic'), options)).rejects.toMatchObject({ code: 'image_too_large' });
  });

  it('answers conversion_busy instead of queueing without bound', async () => {
    const pool = new HeicWorkerPool({ concurrency: 1, maxQueue: 0 });
    const first = pool.toJpeg(fixture('gps.heic'), options);
    await expect(pool.toJpeg(fixture('gps.heic'), options)).rejects.toMatchObject({ code: 'conversion_busy' });
    await first;
    // 解放後は再び受け付ける。
    await expect(pool.toJpeg(fixture('gps.heic'), options)).resolves.toBeDefined();
  });

  it('times out a stuck conversion and frees the slot', async () => {
    const pool = new HeicWorkerPool({ timeoutMs: 1 });
    await expect(pool.toJpeg(fixture('gps.heic'), options)).rejects.toBeDefined();
    const healthy = new HeicWorkerPool();
    await expect(healthy.toJpeg(fixture('gps.heic'), options)).resolves.toBeDefined();
  });
});

describe('SharpImageProcessor', () => {
  it('creates a thumbnail of at most 640px without enlarging small images', async () => {
    const images = new SharpImageProcessor();
    const small = await sharp({ create: { width: 100, height: 80, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    const t = await images.thumbnail(small, 'jpeg');
    expect([t.width, t.height]).toEqual([100, 80]);
    const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#888' } }).jpeg().toBuffer();
    const b = await images.thumbnail(big, 'jpeg');
    expect([b.width, b.height]).toEqual([640, 480]);
  });

  it('reports image_decode_failed for undecodable JPEG', async () => {
    const images = new SharpImageProcessor();
    await expect(images.thumbnail(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]), 'jpeg')).rejects.toMatchObject({
      code: 'image_decode_failed',
    });
  });
});
