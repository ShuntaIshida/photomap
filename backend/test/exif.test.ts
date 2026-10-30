import { describe, expect, it } from 'vitest';
import { extractExif, isValidGps, parseExifDate } from '../src/services/exif.js';
import { MAX_ORIGINAL_BYTES, sanitizeFilename, sniffImageKind } from '../src/services/photoFormat.js';
import { makeHeicLike, makeJpegWithExif } from './exifFixture.js';

describe('extractExif', () => {
  it('reads GPS, capture time (with offset), and dimensions from a JPEG', async () => {
    const buf = makeJpegWithExif({ lat: 39.3853, lng: 140.0488, date: '2026:10:03 14:05:09', offset: '+09:00', width: 4032, height: 3024 });
    const r = await extractExif(buf);
    expect(r.latitude).toBeCloseTo(39.3853, 3);
    expect(r.longitude).toBeCloseTo(140.0488, 3);
    expect(r.capturedAt?.toISOString()).toBe('2026-10-03T05:05:09.000Z');
    expect(r.capturedAtTimeZoneKnown).toBe(true);
    expect(r.width).toBe(4032);
    expect(r.height).toBe(3024);
  });

  it('assumes JST and flags the time zone as unknown when there is no offset', async () => {
    const r = await extractExif(makeJpegWithExif({ lat: 39.2, lng: 139.9, date: '2026:10:03 14:05:09' }));
    expect(r.capturedAt?.toISOString()).toBe('2026-10-03T05:05:09.000Z');
    expect(r.capturedAtTimeZoneKnown).toBe(false);
  });

  it('handles southern/western hemispheres', async () => {
    const r = await extractExif(makeJpegWithExif({ lat: -33.8688, lng: -70.5 }));
    expect(r.latitude).toBeCloseTo(-33.8688, 3);
    expect(r.longitude).toBeCloseTo(-70.5, 3);
  });

  it('allows a missing capture time', async () => {
    const r = await extractExif(makeJpegWithExif({ lat: 39.2, lng: 139.9 }));
    expect(r.capturedAt).toBeNull();
  });

  it('rejects photos without GPS with no_gps', async () => {
    await expect(extractExif(makeJpegWithExif({ date: '2026:10:03 14:05:09' }))).rejects.toMatchObject({ code: 'no_gps', status: 422 });
  });

  it('rejects the (0,0) placeholder some cameras write', async () => {
    await expect(extractExif(makeJpegWithExif({ lat: 0, lng: 0 }))).rejects.toMatchObject({ code: 'no_gps' });
  });

  it('treats unreadable data as no GPS instead of crashing', async () => {
    await expect(extractExif(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]))).rejects.toMatchObject({ code: 'no_gps' });
  });
});

describe('parseExifDate / isValidGps', () => {
  it('parses offsets and rejects invalid dates', () => {
    expect(parseExifDate('2026:01:02 03:04:05', '-05:00')?.date.toISOString()).toBe('2026-01-02T08:04:05.000Z');
    expect(parseExifDate('0000:00:00 00:00:00', undefined)).toBeNull();
    expect(parseExifDate('garbage', '+09:00')).toBeNull();
    expect(parseExifDate(undefined, undefined)).toBeNull();
  });

  it('validates coordinate ranges', () => {
    expect(isValidGps(39, 140)).toBe(true);
    expect(isValidGps(91, 0)).toBe(false);
    expect(isValidGps(0, 181)).toBe(false);
    expect(isValidGps(NaN, 1)).toBe(false);
    expect(isValidGps(undefined, 1)).toBe(false);
  });
});

describe('photoFormat', () => {
  it('detects real formats from magic bytes', () => {
    expect(sniffImageKind(makeJpegWithExif({ lat: 1, lng: 1 }))).toBe('jpeg');
    expect(sniffImageKind(makeHeicLike('heic'))).toBe('heic');
    expect(sniffImageKind(makeHeicLike('mif1'))).toBe('heic');
    expect(sniffImageKind(makeHeicLike('avif'))).toBeNull();
    expect(sniffImageKind(Buffer.from('GIF89a......'))).toBeNull();
    expect(sniffImageKind(Buffer.from('<?php echo 1; ?>'))).toBeNull();
    expect(sniffImageKind(Buffer.alloc(0))).toBeNull();
  });

  it('sanitizes file names', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\me\\IMG_0001.HEIC')).toBe('IMG_0001.HEIC');
    expect(sanitizeFilename('a<b>:"c|d?e*.jpg')).toBe('abcde.jpg');
    expect(sanitizeFilename('  ...hidden.jpg ')).toBe('hidden.jpg');
    expect(sanitizeFilename('')).toBe('photo');
    expect(sanitizeFilename('写真 1.jpg')).toBe('写真 1.jpg');
    expect([...sanitizeFilename('x'.repeat(500))].length).toBe(120);
  });

  it('exposes the size limit', () => {
    expect(MAX_ORIGINAL_BYTES).toBe(20 * 1024 * 1024);
  });
});
