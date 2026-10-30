import { describe, expect, it } from 'vitest';
import { inspectPhoto, isValidGps, MAX_ORIGINAL_BYTES, sniffImageKind } from './photoFile';
import { makeHeicLike, makeJpegWithGps } from '../testing/exifFixture';

const blob = (bytes: Uint8Array, type = 'image/jpeg') => new Blob([bytes as BlobPart], { type });

describe('sniffImageKind', () => {
  it('uses magic bytes, not the declared type or extension', () => {
    expect(sniffImageKind(makeJpegWithGps(39, 140))).toBe('jpeg');
    expect(sniffImageKind(makeHeicLike('heic'))).toBe('heic');
    expect(sniffImageKind(makeHeicLike('mif1'))).toBe('heic');
    expect(sniffImageKind(makeHeicLike('avif'))).toBeNull();
    expect(sniffImageKind(new TextEncoder().encode('GIF89a......'))).toBeNull();
    expect(sniffImageKind(new Uint8Array())).toBeNull();
  });
});

describe('inspectPhoto (pre-upload check)', () => {
  it('accepts a JPEG with GPS and returns the coordinates', async () => {
    const r = await inspectPhoto(blob(makeJpegWithGps(39.3853, 140.0488)));
    expect(r.ok).toBe(true);
    if (r.ok && !r.serverCheck) {
      expect(r.kind).toBe('jpeg');
      expect(r.latitude).toBeCloseTo(39.3853, 3);
      expect(r.longitude).toBeCloseTo(140.0488, 3);
    }
  });

  it('rejects a JPEG without GPS with a user-facing reason', async () => {
    const r = await inspectPhoto(blob(makeJpegWithGps()));
    expect(r).toMatchObject({ ok: false, code: 'no_gps' });
    if (!r.ok) expect(r.reason).toContain('GPS');
  });

  it('rejects the (0,0) placeholder as no GPS', async () => {
    expect(await inspectPhoto(blob(makeJpegWithGps(0, 0)))).toMatchObject({ ok: false, code: 'no_gps' });
  });

  it('rejects non-JPEG/HEIC content even when it is named or typed like a photo', async () => {
    const r = await inspectPhoto(blob(new TextEncoder().encode('<html>'), 'image/jpeg'));
    expect(r).toMatchObject({ ok: false, code: 'unsupported' });
  });

  it('names the actual size when a file exceeds the limit', async () => {
    const big = { size: 25 * 1024 * 1024, slice: () => { throw new Error('should not read'); } } as unknown as Blob;
    const r = await inspectPhoto(big);
    expect(r).toMatchObject({ ok: false, code: 'too_large' });
    if (!r.ok) expect(r.reason).toMatch(/25\.0MB.*20\.0MB/);
  });

  it('rejects empty and oversized files without reading them', async () => {
    expect(await inspectPhoto(new Blob([]))).toMatchObject({ ok: false, code: 'empty' });
    const big = { size: MAX_ORIGINAL_BYTES + 1, arrayBuffer: () => Promise.reject(new Error('should not read')) } as unknown as Blob;
    expect(await inspectPhoto(big)).toMatchObject({ ok: false, code: 'too_large' });
  });

  it('leaves a HEIC without browser-readable GPS to the server instead of rejecting it', async () => {
    expect(await inspectPhoto(blob(makeHeicLike('heic'), 'image/heic'))).toMatchObject({ ok: true, kind: 'heic', serverCheck: true });
  });

  it('does not call a JPEG whose EXIF cannot be parsed "no GPS"', async () => {
    const broken = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x49, 0x49, 0x2a, 0, 0xff, 0xff, 0xff, 0xff]);
    const r = await inspectPhoto(blob(broken));
    if (r.ok) expect(r.serverCheck).toBe(true);
    else expect(r.code).toBe('no_gps');
  });
});

describe('isValidGps', () => {
  it('validates ranges and placeholders', () => {
    expect(isValidGps(39.2, 139.9)).toBe(true);
    expect(isValidGps(0, 0)).toBe(false);
    expect(isValidGps(95, 10)).toBe(false);
    expect(isValidGps(10, 200)).toBe(false);
    expect(isValidGps(undefined, 10)).toBe(false);
  });
});
