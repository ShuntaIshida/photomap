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
    if (r.ok) {
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

  it('rejects empty and oversized files without reading them', async () => {
    expect(await inspectPhoto(new Blob([]))).toMatchObject({ ok: false, code: 'empty' });
    const big = { size: MAX_ORIGINAL_BYTES + 1, arrayBuffer: () => Promise.reject(new Error('should not read')) } as unknown as Blob;
    expect(await inspectPhoto(big)).toMatchObject({ ok: false, code: 'too_large' });
  });

  it('treats a HEIC without readable EXIF as no GPS (never crashes)', async () => {
    expect(await inspectPhoto(blob(makeHeicLike('heic'), 'image/heic'))).toMatchObject({ ok: false, code: 'no_gps' });
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
