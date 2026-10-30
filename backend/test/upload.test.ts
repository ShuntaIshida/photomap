import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { errors } from '../src/errors.js';
import { mapGoogleError } from '../src/services/driveGateway.js';
import { UploadLimiter } from '../src/services/uploadLimiter.js';
import { makeHeicLike, makeJpegWithExif } from './exifFixture.js';
import { build } from './helpers.js';

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const gpsJpeg = (extra = {}) => makeJpegWithExif({ lat: 39.3853, lng: 140.0488, date: '2026:10:03 14:05:09', offset: '+09:00', width: 4032, height: 3024, ...extra });
const thumb = () => makeJpegWithExif({});

type Ctx = ReturnType<typeof build>;

async function setup(options: Parameters<typeof build>[0] = {}) {
  const ctx = build(options);
  await ctx.tokens.save('refresh');
  ctx.gateway.folders = [
    { id: 'folder-yurihonjo', name: 'yurihonjo' },
    { id: 'folder-nikaho', name: 'nikaho' },
  ];
  return ctx;
}

interface UploadOptions {
  token?: string | null;
  file?: Buffer;
  thumbnail?: Buffer | null;
  filename?: string;
  fields?: Record<string, string>;
}

function upload(ctx: Ctx, slug: string, o: UploadOptions = {}) {
  let req = request(ctx.app).post(`/regions/${slug}/photos`);
  if (o.token !== null) req = req.set(bearer(o.token ?? 'user-token'));
  for (const [k, v] of Object.entries(o.fields ?? {})) req = req.field(k, v);
  req = req.attach('file', o.file ?? gpsJpeg(), { filename: o.filename ?? 'IMG_0001.jpg', contentType: 'image/jpeg' });
  if (o.thumbnail !== null) req = req.attach('thumbnail', o.thumbnail ?? thumb(), { filename: 'thumb.jpg', contentType: 'image/jpeg' });
  return req;
}

describe('POST /regions/:slug/photos — authentication and authorization', () => {
  it('requires a valid Firebase ID token and writes nothing otherwise', async () => {
    const ctx = await setup();
    expect((await upload(ctx, 'yurihonjo', { token: null })).status).toBe(401);
    expect((await upload(ctx, 'yurihonjo', { token: 'bogus' })).status).toBe(401);
    expect(ctx.gateway.uploads).toHaveLength(0);
    expect(ctx.photos.records.size).toBe(0);
  });

  it('stores the photo in the Drive folder resolved from the region slug', async () => {
    const ctx = await setup();
    const res = await upload(ctx, 'yurihonjo');
    expect(res.status).toBe(201);
    expect(res.body.photoId).toMatch(/^yurihonjo-[0-9a-f]{32}$/);

    const [original, thumbnail] = ctx.gateway.uploads;
    expect(original?.parentId).toBe('folder-yurihonjo');
    expect(original?.mimeType).toBe('image/jpeg');
    expect(thumbnail?.parentId).toBe('thumbs-of-folder-yurihonjo');
    expect(thumbnail?.mimeType).toBe('image/jpeg');
  });

  it('records metadata from the verified token and the original EXIF, not from the client', async () => {
    const ctx = await setup();
    const res = await upload(ctx, 'yurihonjo', { filename: 'IMG_0001.jpg' });
    const rec = ctx.photos.records.get(res.body.photoId)!;
    expect(rec.regionId).toBe('yurihonjo');
    expect(rec.uploaderUid).toBe('user-uid');
    expect(rec.uploaderName).toBe('Test User');
    expect(rec.latitude).toBeCloseTo(39.3853, 3);
    expect(rec.longitude).toBeCloseTo(140.0488, 3);
    expect(rec.capturedAt?.toISOString()).toBe('2026-10-03T05:05:09.000Z');
    expect(rec.capturedAtTimeZoneKnown).toBe(true);
    expect(rec.width).toBe(4032);
    expect(rec.mimeType).toBe('image/jpeg');
    expect(rec.driveFileId).toBe(ctx.gateway.uploads[0]?.id);
    expect(rec.thumbnailDriveFileId).toBe(ctx.gateway.uploads[1]?.id);
    expect(rec.originalFilename).toBe('IMG_0001.jpg');
  });

  it('ignores client-supplied folder IDs, region IDs and uploader IDs', async () => {
    const ctx = await setup();
    const res = await upload(ctx, 'yurihonjo', {
      fields: { folderId: 'attacker-folder', parentId: 'attacker-folder', regionId: 'nikaho', uploaderUid: 'admin-uid', latitude: '0', driveFileId: 'x' },
    });
    expect(res.status).toBe(201);
    const rec = ctx.photos.records.get(res.body.photoId)!;
    expect(ctx.gateway.uploads.map((u) => u.parentId)).not.toContain('attacker-folder');
    expect(ctx.gateway.uploads[0]?.parentId).toBe('folder-yurihonjo');
    expect(rec.regionId).toBe('yurihonjo');
    expect(rec.uploaderUid).toBe('user-uid');
    expect(rec.latitude).toBeCloseTo(39.3853, 3);
  });

  it('writes to the other region only when that region is in the URL', async () => {
    const ctx = await setup();
    const res = await upload(ctx, 'nikaho');
    expect(res.status).toBe(201);
    expect(ctx.gateway.uploads[0]?.parentId).toBe('folder-nikaho');
    expect(ctx.photos.records.get(res.body.photoId)?.regionId).toBe('nikaho');
  });

  it('rejects regions that are not Drive folders, and malformed slugs', async () => {
    const ctx = await setup();
    for (const slug of ['akita', 'noshiro', 'Yurihonjo', '..', 'a%2Fb', 'x'.repeat(80)]) {
      const res = await upload(ctx, slug);
      expect([404], slug).toContain(res.status);
    }
    expect(ctx.gateway.uploads).toHaveLength(0);
    expect(ctx.photos.records.size).toBe(0);
  });
});

describe('POST /regions/:slug/photos — validation', () => {
  it('rejects photos without GPS (422 no_gps) and stores nothing', async () => {
    const ctx = await setup();
    const res = await upload(ctx, 'yurihonjo', { file: makeJpegWithExif({ date: '2026:10:03 14:05:09' }) });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('no_gps');
    expect(ctx.gateway.uploads).toHaveLength(0);
    expect(ctx.photos.records.size).toBe(0);
  });

  it('rejects non-image content even if it claims image/jpeg', async () => {
    const ctx = await setup();
    const res = await upload(ctx, 'yurihonjo', { file: Buffer.from('<script>alert(1)</script>'), filename: 'evil.jpg' });
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('unsupported_media_type');
    expect(ctx.gateway.uploads).toHaveLength(0);
  });

  it('rejects an empty file', async () => {
    const ctx = await setup();
    const res = await upload(ctx, 'yurihonjo', { file: Buffer.alloc(0) });
    expect(res.status).toBe(400);
  });

  it('requires a JPEG thumbnail', async () => {
    const ctx = await setup();
    expect((await upload(ctx, 'yurihonjo', { thumbnail: null })).status).toBe(400);
    expect((await upload(ctx, 'yurihonjo', { thumbnail: Buffer.from('not a jpeg') })).status).toBe(400);
    expect(ctx.gateway.uploads).toHaveLength(0);
  });

  it('rejects originals over 20 MB (413)', async () => {
    const ctx = await setup();
    const big = Buffer.concat([gpsJpeg(), Buffer.alloc(21 * 1024 * 1024)]);
    const res = await upload(ctx, 'yurihonjo', { file: big });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('file_too_large');
    expect(ctx.gateway.uploads).toHaveLength(0);
  });

  it('rejects oversized thumbnails', async () => {
    const ctx = await setup();
    const res = await upload(ctx, 'yurihonjo', { thumbnail: Buffer.concat([thumb(), Buffer.alloc(1024 * 1024 + 10)]) });
    expect(res.status).toBe(413);
  });

  it('rejects non-multipart requests', async () => {
    const ctx = await setup();
    const res = await request(ctx.app).post('/regions/yurihonjo/photos').set(bearer('user-token')).send({ hello: 'world' });
    expect(res.status).toBe(400);
  });

  it('accepts HEIC by magic bytes and records image/heic', async () => {
    const ctx = await setup({
      extract: async () => ({ latitude: 39.2, longitude: 139.9, capturedAt: null, capturedAtTimeZoneKnown: false, width: null, height: null }),
    });
    const res = await upload(ctx, 'nikaho', { file: makeHeicLike('heic'), filename: 'IMG_0002.HEIC' });
    expect(res.status).toBe(201);
    expect(ctx.photos.records.get(res.body.photoId)?.mimeType).toBe('image/heic');
    expect(ctx.gateway.uploads[0]?.mimeType).toBe('image/heic');
  });

  it('rejects a photo uploaded twice to the same region (409) without a second Drive write', async () => {
    const ctx = await setup();
    expect((await upload(ctx, 'yurihonjo')).status).toBe(201);
    const again = await upload(ctx, 'yurihonjo');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('duplicate_photo');
    expect(ctx.gateway.uploads).toHaveLength(2);
    expect(ctx.photos.records.size).toBe(1);
  });
});

describe('POST /regions/:slug/photos — failure handling and limits', () => {
  it('removes the original from Drive when the thumbnail upload fails', async () => {
    const ctx = await setup();
    ctx.gateway.failUploadNumber = 2;
    const res = await upload(ctx, 'yurihonjo');
    expect(res.status).toBe(502);
    expect(ctx.photos.records.size).toBe(0);
    expect(ctx.gateway.deleted).toEqual(['drive-file-1']);
  });

  it('removes both Drive files when saving to Firestore fails', async () => {
    const ctx = await setup();
    ctx.photos.failNextCreate = true;
    const res = await upload(ctx, 'yurihonjo');
    expect(res.status).toBe(500);
    expect(ctx.photos.records.size).toBe(0);
    expect(ctx.gateway.deleted.sort()).toEqual(['drive-file-1', 'drive-file-2']);
  });

  it('cleans up and reports 409 when a concurrent upload wins the race', async () => {
    const ctx = await setup();
    await upload(ctx, 'yurihonjo');
    ctx.photos.exists = async () => false;
    const res = await upload(ctx, 'yurihonjo');
    expect(res.status).toBe(409);
    expect(ctx.gateway.deleted.sort()).toEqual(['drive-file-3', 'drive-file-4']);
    expect(ctx.photos.records.size).toBe(1);
  });

  it('rate limits uploads per user (429) without affecting other users', async () => {
    const ctx = await setup({ limiter: new UploadLimiter(2, 60_000, 2) });
    expect((await upload(ctx, 'yurihonjo', { file: gpsJpeg({ lat: 39.1 }) })).status).toBe(201);
    expect((await upload(ctx, 'yurihonjo', { file: gpsJpeg({ lat: 39.2 }) })).status).toBe(201);
    const limited = await upload(ctx, 'yurihonjo', { file: gpsJpeg({ lat: 39.3 }) });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('rate_limited');
    expect((await upload(ctx, 'yurihonjo', { token: 'user2-token', file: gpsJpeg({ lat: 39.4 }) })).status).toBe(201);
  });

  it('reports a re-authorization error when the stored token lacks write scope', async () => {
    const ctx = await setup();
    ctx.gateway.uploadFile = async () => {
      throw errors.driveScopeInsufficient();
    };
    const res = await upload(ctx, 'yurihonjo');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('drive_scope_insufficient');
  });

  it('reports drive_not_authorized when the owner has not authorized yet', async () => {
    const ctx = build();
    const res = await upload(ctx, 'yurihonjo');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('drive_not_authorized');
  });
});

describe('UploadLimiter', () => {
  it('limits concurrency and releases slots', () => {
    const l = new UploadLimiter(100, 60_000, 2);
    const a = l.acquire('u');
    l.acquire('u');
    expect(() => l.acquire('u')).toThrow();
    a();
    a(); // 二重解放しても数えすぎない
    expect(() => l.acquire('u')).not.toThrow();
  });

  it('forgets attempts after the window', () => {
    let now = 0;
    const l = new UploadLimiter(2, 1000, 10, () => now);
    l.acquire('u')();
    l.acquire('u')();
    expect(() => l.acquire('u')).toThrow();
    now = 1001;
    expect(() => l.acquire('u')).not.toThrow();
  });
});

describe('GET /photos/:photoId/thumbnail (safe delivery)', () => {
  it('serves only registered thumbnails, publicly, with long-lived caching', async () => {
    const ctx = await setup();
    const t = thumb();
    const { body } = await upload(ctx, 'yurihonjo', { thumbnail: t });
    const res = await request(ctx.app).get(`/photos/${body.photoId}/thumbnail`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(res.body as Buffer, t)).toBe(0);
  });

  it('never exposes the original or arbitrary Drive files', async () => {
    const ctx = await setup();
    const { body } = await upload(ctx, 'yurihonjo');
    const original = ctx.photos.records.get(body.photoId)!.driveFileId;
    for (const id of [original, 'drive-file-1', `${body.photoId}/../x`, 'not-a-photo', 'yurihonjo-' + '0'.repeat(32)]) {
      const res = await request(ctx.app).get(`/photos/${encodeURIComponent(id)}/thumbnail`);
      expect(res.status, id).toBe(404);
    }
    expect((await request(ctx.app).get(`/photos/${body.photoId}/original`)).status).toBe(404);
  });
});

describe('CORS for uploads', () => {
  it('allows the GitHub Pages origin to send the Authorization header, and nobody else', async () => {
    const { app } = build();
    const ok = await request(app)
      .options('/regions/yurihonjo/photos')
      .set('Origin', 'https://shuntaishida.github.io')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization');
    expect(ok.headers['access-control-allow-origin']).toBe('https://shuntaishida.github.io');
    expect(ok.headers['access-control-allow-headers']).toMatch(/authorization/i);
    const bad = await request(app)
      .options('/regions/yurihonjo/photos')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('mapGoogleError', () => {
  const gerr = (status: number, body: unknown = {}, message = '') => Object.assign(new Error(message), { response: { status, data: body } });

  it('maps Drive failures to specific, actionable errors', () => {
    expect(mapGoogleError(gerr(403, { error: { errors: [{ reason: 'insufficientPermissions' }] } })).code).toBe('drive_scope_insufficient');
    expect(mapGoogleError(gerr(403, {}, 'Request had insufficient authentication scopes.')).code).toBe('drive_scope_insufficient');
    expect(mapGoogleError(gerr(404)).code).toBe('drive_parent_inaccessible');
    expect(mapGoogleError(gerr(403)).code).toBe('drive_parent_inaccessible');
    expect(mapGoogleError(gerr(401)).code).toBe('drive_authorization_invalid');
    expect(mapGoogleError(gerr(400, { error: 'invalid_grant' })).code).toBe('drive_authorization_invalid');
    expect(mapGoogleError(gerr(500)).code).toBe('drive_unavailable');
  });
});
