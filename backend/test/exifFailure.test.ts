import { describe, expect, it, vi } from 'vitest';

// exifrの解析そのものが失敗する状況を再現する。
vi.mock('exifr', () => ({
  default: {
    gps: async () => {
      throw new Error('boom');
    },
    parse: async () => {
      throw new Error('boom');
    },
  },
}));

const { extractExif } = await import('../src/services/exif.js');
const { makeJpegWithExif } = await import('./exifFixture.js');

describe('extractExif failure classification', () => {
  it('reports exif_parse_failed (not no_gps) when EXIF parsing itself fails', async () => {
    await expect(extractExif(makeJpegWithExif({ lat: 39, lng: 140 }))).rejects.toMatchObject({
      code: 'exif_parse_failed',
    });
  });
});
