import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { errors } from '../src/errors.js';
import { makeDecodableJpeg } from './exifFixture.js';
import { build } from './helpers.js';

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const jpeg = (lat: number) => makeDecodableJpeg({ lat, lng: 140.0488, date: '2026:10:03 14:05:09', offset: '+09:00' });

async function setup() {
  const ctx = build();
  await ctx.tokens.save('refresh');
  ctx.gateway.folders = [
    { id: 'folder-yurihonjo', name: 'yurihonjo' },
    { id: 'folder-nikaho', name: 'nikaho' },
  ];
  return ctx;
}
type Ctx = Awaited<ReturnType<typeof setup>>;

async function post(ctx: Ctx, token: string, lat = 39.1) {
  const res = await request(ctx.app)
    .post('/regions/yurihonjo/photos')
    .set(bearer(token))
    .attach('file', jpeg(lat), { filename: 'IMG_0001.jpg', contentType: 'image/jpeg' });
  expect(res.status).toBe(201);
  return res.body.photoId as string;
}

const patch = (ctx: Ctx, id: string, token: string | null, body: unknown) => {
  let r = request(ctx.app).patch(`/photos/${id}`);
  if (token) r = r.set(bearer(token));
  return r.send(body as object);
};
const del = (ctx: Ctx, id: string, token: string | null) => {
  let r = request(ctx.app).delete(`/photos/${id}`);
  if (token) r = r.set(bearer(token));
  return r;
};

describe('PATCH /photos/:photoId (rename)', () => {
  it('lets the uploader set a display title without touching the original file name', async () => {
    const ctx = await setup();
    const id = await post(ctx, 'user-token');
    const res = await patch(ctx, id, 'user-token', { title: '  調査地点 A  ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ title: '調査地点 A' });
    expect(ctx.photos.titles.get(id)).toBe('調査地点 A');
    expect(ctx.photos.records.get(id)!.originalFilename).toBe('IMG_0001.jpg');
    expect(ctx.gateway.uploads[0]!.name).toContain('IMG_0001.jpg');
  });

  it('lets an administrator rename any photo', async () => {
    const ctx = await setup();
    const id = await post(ctx, 'user-token');
    expect((await patch(ctx, id, 'admin-token', { title: 'by admin' })).status).toBe(200);
  });

  it('rejects other users, anonymous users and bad tokens without writing', async () => {
    const ctx = await setup();
    const id = await post(ctx, 'user-token');
    const other = await patch(ctx, id, 'user2-token', { title: 'x' });
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe('not_photo_owner');
    expect((await patch(ctx, id, null, { title: 'x' })).status).toBe(401);
    expect((await patch(ctx, id, 'bogus', { title: 'x' })).status).toBe(401);
    expect(ctx.photos.titles.size).toBe(0);
  });

  it('allows only administrators on legacy photos that have no uploader UID', async () => {
    const ctx = await setup();
    const id = await post(ctx, 'user-token');
    ctx.photos.legacyNoUploader.add(id);
    expect((await patch(ctx, id, 'user-token', { title: 'x' })).status).toBe(403);
    expect((await patch(ctx, id, 'admin-token', { title: 'x' })).status).toBe(200);
  });

  it('validates the title', async () => {
    const ctx = await setup();
    const id = await post(ctx, 'user-token');
    for (const body of [{ title: '' }, { title: '   ' }, { title: 'a'.repeat(101) }, { title: 'bad\u0000name' }, { title: 5 }, {}, []]) {
      const res = await patch(ctx, id, 'user-token', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await patch(ctx, id, 'user-token', { title: 'あ'.repeat(100) })).status).toBe(200);
    const malformed = await request(ctx.app).patch(`/photos/${id}`).set(bearer('user-token')).set('Content-Type', 'application/json').send('{oops');
    expect(malformed.status).toBe(400);
    expect(ctx.photos.titles.get(id)).toBe('あ'.repeat(100));
  });

  it('returns 404 for unknown or malformed IDs and 500 without partial state when Firestore fails', async () => {
    const ctx = await setup();
    expect((await patch(ctx, `yurihonjo-${'c'.repeat(32)}`, 'user-token', { title: 'x' })).status).toBe(404);
    expect((await patch(ctx, 'not-a-photo', 'user-token', { title: 'x' })).status).toBe(404);
    const id = await post(ctx, 'user-token');
    ctx.photos.failNextUpdate = true;
    expect((await patch(ctx, id, 'user-token', { title: 'x' })).status).toBe(500);
    expect(ctx.photos.titles.size).toBe(0);
  });

  it('allows the GitHub Pages origin to send PATCH and DELETE', async () => {
    const ctx = await setup();
    for (const method of ['PATCH', 'DELETE']) {
      const res = await request(ctx.app)
        .options('/photos/x')
        .set('Origin', 'https://shuntaishida.github.io')
        .set('Access-Control-Request-Method', method)
        .set('Access-Control-Request-Headers', 'authorization,content-type');
      expect(res.headers['access-control-allow-methods']).toContain(method);
    }
  });
});

describe('DELETE /photos/:photoId', () => {
  it('lets the uploader delete the original, the thumbnail and the Firestore record only', async () => {
    const ctx = await setup();
    const a = await post(ctx, 'user-token', 39.1);
    const b = await post(ctx, 'user-token', 39.2);
    const [origA, thumbA] = [ctx.photos.records.get(a)!.driveFileId, ctx.photos.records.get(a)!.thumbnailDriveFileId];
    const res = await del(ctx, a, 'user-token');
    expect(res.status).toBe(204);
    expect(ctx.gateway.deleted.sort()).toEqual([origA, thumbA].sort());
    expect(ctx.photos.records.has(a)).toBe(false);
    // 他の写真・フォルダーは残る。
    expect(ctx.photos.records.has(b)).toBe(true);
    expect(ctx.gateway.deleted).not.toContain('folder-yurihonjo');
    expect(ctx.gateway.deleted).not.toContain(ctx.photos.records.get(b)!.driveFileId);
    // 削除後は配信されない。
    expect((await request(ctx.app).get(`/photos/${a}/thumbnail`)).status).toBe(404);
    expect((await request(ctx.app).get(`/photos/${a}/original`)).status).toBe(404);
    expect((await request(ctx.app).get(`/photos/${b}/thumbnail`)).status).toBe(200);
  });

  it('lets an administrator delete any photo', async () => {
    const ctx = await setup();
    const id = await post(ctx, 'user-token');
    expect((await del(ctx, id, 'admin-token')).status).toBe(204);
    expect(ctx.photos.records.size).toBe(0);
  });

  it('rejects other users and anonymous users without deleting anything', async () => {
    const ctx = await setup();
    const id = await post(ctx, 'user-token');
    expect((await del(ctx, id, 'user2-token')).status).toBe(403);
    expect((await del(ctx, id, null)).status).toBe(401);
    expect((await del(ctx, id, 'bogus')).status).toBe(401);
    expect(ctx.gateway.deleted).toHaveLength(0);
    expect(ctx.photos.records.has(id)).toBe(true);
  });

  it('allows only administrators to delete legacy photos without an uploader UID', async () => {
    const ctx = await setup();
    const id = await post(ctx, 'user-token');
    ctx.photos.legacyNoUploader.add(id);
    expect((await del(ctx, id, 'user-token')).status).toBe(403);
    expect((await del(ctx, id, 'admin-token')).status).toBe(204);
  });

  it('returns 404 for unknown photos and never accepts a Drive file ID as the target', async () => {
    const ctx = await setup();
    const id = await post(ctx, 'user-token');
    const drive = ctx.photos.records.get(id)!.driveFileId;
    expect((await del(ctx, drive, 'admin-token')).status).toBe(404);
    expect((await del(ctx, `yurihonjo-${'d'.repeat(32)}`, 'admin-token')).status).toBe(404);
    expect(ctx.gateway.deleted).toHaveLength(0);
  });

  it('refuses to delete when the stored reference points at a region folder', async () => {
    const ctx = await setup();
    const id = await post(ctx, 'user-token');
    ctx.photos.records.get(id)!.driveFileId = 'folder-yurihonjo';
    const res = await del(ctx, id, 'admin-token');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('unsafe_delete_target');
    expect(ctx.gateway.deleted).toHaveLength(0);
    expect(ctx.photos.records.has(id)).toBe(true);
  });

  it('keeps the Firestore record when a Drive deletion fails, and a retry completes it', async () => {
    const ctx = await setup();
    const id = await post(ctx, 'user-token');
    const real = ctx.gateway.deleteFile.bind(ctx.gateway);
    let calls = 0;
    ctx.gateway.deleteFile = async (fileId: string) => {
      if (++calls === 2) throw errors.driveUnavailable();
      return real(fileId);
    };
    const failed = await del(ctx, id, 'user-token');
    expect(failed.status).toBe(502);
    expect(ctx.photos.records.has(id)).toBe(true);

    // 再実行: 既に消えたファイルは成功扱いで、残りを消して完了する。
    ctx.gateway.deleteFile = real;
    expect((await del(ctx, id, 'user-token')).status).toBe(204);
    expect(ctx.photos.records.has(id)).toBe(false);
  });

  it('reports a Firestore failure after the Drive files are gone, and a retry succeeds', async () => {
    const ctx = await setup();
    const id = await post(ctx, 'user-token');
    ctx.photos.failNextDelete = true;
    expect((await del(ctx, id, 'user-token')).status).toBe(500);
    expect(ctx.photos.records.has(id)).toBe(true);
    expect((await del(ctx, id, 'user-token')).status).toBe(204);
    expect(ctx.photos.records.has(id)).toBe(false);
  });
});

describe('viewing stays public', () => {
  it('serves thumbnails and originals to anonymous users', async () => {
    const ctx = await setup();
    const id = await post(ctx, 'user-token');
    expect((await request(ctx.app).get(`/photos/${id}/thumbnail`)).status).toBe(200);
    expect((await request(ctx.app).get(`/photos/${id}/original`)).status).toBe(200);
  });
});
