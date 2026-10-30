import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { REGION_SEEDS } from '../src/services/regionMeta.js';
import { build } from './helpers.js';

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function setup(folders: { id: string; name: string }[] = [
  { id: 'f-yuri', name: 'yurihonjo' },
  { id: 'f-nikaho', name: 'nikaho' },
  { id: 'f-ogaki', name: 'ogaki' },
]) {
  const ctx = build();
  await ctx.tokens.save('refresh');
  ctx.gateway.folders = folders;
  return ctx;
}

describe('region registration from Drive folders', () => {
  it('registers the three known regions with the right display names, centers and zoom', async () => {
    const ctx = await setup();
    const res = await request(ctx.app).get('/regions');
    expect(res.body.regions.map((r: { slug: string }) => r.slug)).toEqual(['nikaho', 'ogaki', 'yurihonjo']);
    const ogaki = ctx.regionRepo.docs.get('ogaki')!;
    expect(ogaki).toMatchObject({ displayName: '大垣', zoom: 12, status: 'configured', driveFolderId: 'f-ogaki' });
    const c = ogaki.center as { lat: number; lng: number };
    // 岐阜県大垣市（秋田県ではない）。
    expect(c.lat).toBeGreaterThan(35.2);
    expect(c.lat).toBeLessThan(35.5);
    expect(c.lng).toBeGreaterThan(136.5);
    expect(c.lng).toBeLessThan(136.8);
    expect(ctx.regionRepo.docs.get('yurihonjo')).toMatchObject({ displayName: '由利本荘', center: { lat: 39.3853, lng: 140.0488 } });
    expect(ctx.regionRepo.docs.get('nikaho')).toMatchObject({ displayName: 'にかほ', center: { lat: 39.2, lng: 139.9061 } });
    expect(REGION_SEEDS.ogaki!.displayName).toBe('大垣');
  });

  it('registers an unknown new folder as unconfigured without guessing a location', async () => {
    const ctx = await setup([{ id: 'f-new', name: 'tsuruoka' }]);
    await request(ctx.app).get('/regions');
    const doc = ctx.regionRepo.docs.get('tsuruoka')!;
    expect(doc).toMatchObject({ slug: 'tsuruoka', driveFolderId: 'f-new', status: 'unconfigured' });
    expect(doc.center).toBeUndefined();
    expect(doc.displayName).toBeUndefined();
  });

  it('is idempotent and never overwrites existing metadata (including admin edits)', async () => {
    const ctx = await setup();
    ctx.regionRepo.docs.set('ogaki', { slug: 'ogaki', driveFolderId: 'f-ogaki', displayName: '手動設定', center: { lat: 1, lng: 2 }, zoom: 7, status: 'configured' });
    await request(ctx.app).get('/regions');
    await request(ctx.app).get('/regions');
    expect(ctx.regionRepo.docs.get('ogaki')).toMatchObject({ displayName: '手動設定', zoom: 7 });
    // 登録済みの地域では、以後Firestoreを読み直さない。
    const reads = ctx.regionRepo.reads;
    await request(ctx.app).get('/regions');
    expect(ctx.regionRepo.reads).toBe(reads);
  });

  it('still lists regions when Firestore fails, and retries later instead of on every request', async () => {
    const ctx = await setup();
    ctx.regionRepo.failNext = true;
    const res = await request(ctx.app).get('/regions');
    expect(res.status).toBe(200);
    expect(res.body.regions).toHaveLength(3);
    expect(ctx.regionRepo.docs.size).toBe(0);
    const reads = ctx.regionRepo.reads;
    await request(ctx.app).get('/regions');
    expect(ctx.regionRepo.reads).toBe(reads);
  });

  it('ignores Firestore-only regions and duplicate or invalid folder names (Drive is the source of truth)', async () => {
    const ctx = await setup([
      { id: '1', name: 'ogaki' },
      { id: '2', name: 'dup' },
      { id: '3', name: 'dup' },
      { id: '4', name: 'Bad Name' },
    ]);
    ctx.regionRepo.docs.set('akita', { slug: 'akita', displayName: '秋田', center: { lat: 1, lng: 2 }, zoom: 9 });
    const res = await request(ctx.app).get('/regions');
    expect(res.body.regions).toEqual([{ slug: 'ogaki' }]);
    expect([...ctx.regionRepo.docs.keys()].sort()).toEqual(['akita', 'ogaki']);
  });
});

describe('admin region settings API', () => {
  const put = (ctx: Awaited<ReturnType<typeof setup>>, slug: string, token: string | null, body: unknown) => {
    let r = request(ctx.app).put(`/admin/regions/${slug}`);
    if (token) r = r.set(bearer(token));
    return r.send(body as object);
  };
  const valid = { displayName: '  大垣市  ', center: { lat: 35.36, lng: 136.61 }, zoom: 13 };

  it('lets an administrator list regions with their settings', async () => {
    const ctx = await setup([{ id: 'f-new', name: 'tsuruoka' }, { id: 'f-ogaki', name: 'ogaki' }]);
    const res = await request(ctx.app).get('/admin/regions').set(bearer('admin-token'));
    expect(res.status).toBe(200);
    expect(res.body.regions).toEqual([
      expect.objectContaining({ slug: 'ogaki', configured: true, displayName: '大垣' }),
      expect.objectContaining({ slug: 'tsuruoka', configured: false, displayName: null, center: null }),
    ]);
  });

  it('lets an administrator save display name, center and zoom, keeping the Drive folder link', async () => {
    const ctx = await setup();
    const res = await put(ctx, 'ogaki', 'admin-token', valid);
    expect(res.status).toBe(200);
    expect(res.body.region).toMatchObject({ slug: 'ogaki', displayName: '大垣市', zoom: 13, configured: true, driveFolderId: 'f-ogaki' });
    expect(ctx.regionRepo.docs.get('ogaki')).toMatchObject({
      displayName: '大垣市',
      center: { lat: 35.36, lng: 136.61 },
      zoom: 13,
      // 旧フロントエンド向けの互換フィールド。
      name: '大垣市',
      defaultZoom: 13,
      driveFolderId: 'f-ogaki',
      updatedBy: 'admin-uid',
    });
    const after = await request(ctx.app).get('/admin/regions').set(bearer('admin-token'));
    expect(after.body.regions.find((r: { slug: string }) => r.slug === 'ogaki')).toMatchObject({ displayName: '大垣市', zoom: 13 });
  });

  it('rejects ordinary users, anonymous users and bad tokens, and writes nothing', async () => {
    const ctx = await setup();
    expect((await put(ctx, 'ogaki', 'user-token', valid)).status).toBe(403);
    expect((await put(ctx, 'ogaki', null, valid)).status).toBe(401);
    expect((await put(ctx, 'ogaki', 'bogus', valid)).status).toBe(401);
    expect((await request(ctx.app).get('/admin/regions').set(bearer('user-token'))).status).toBe(403);
    expect((await request(ctx.app).get('/admin/regions')).status).toBe(401);
    expect(ctx.regionRepo.docs.has('ogaki')).toBe(false);
  });

  it('only saves regions that exist as Drive folders', async () => {
    const ctx = await setup();
    expect((await put(ctx, 'nowhere', 'admin-token', valid)).status).toBe(404);
    expect((await put(ctx, 'Bad%20Slug', 'admin-token', valid)).status).toBe(404);
    expect(ctx.regionRepo.docs.has('nowhere')).toBe(false);
  });

  it('validates display name, center and zoom', async () => {
    const ctx = await setup();
    const bad: unknown[] = [
      {}, { ...valid, displayName: '' }, { ...valid, displayName: 'a'.repeat(51) }, { ...valid, displayName: 'x\u0000' },
      { ...valid, center: { lat: 91, lng: 0 } }, { ...valid, center: { lat: 0, lng: 181 } }, { ...valid, center: { lat: 'a', lng: 0 } }, { ...valid, center: null },
      { ...valid, zoom: 0 }, { ...valid, zoom: 22 }, { ...valid, zoom: '12' },
    ];
    for (const body of bad) {
      const res = await put(ctx, 'ogaki', 'admin-token', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('invalid_region_metadata');
    }
  });

  it('does not let a client change the slug or the Drive folder link', async () => {
    const ctx = await setup();
    const res = await put(ctx, 'ogaki', 'admin-token', { ...valid, slug: 'hacked', driveFolderId: 'attacker' });
    expect(res.status).toBe(200);
    expect(ctx.regionRepo.docs.get('ogaki')).toMatchObject({ slug: 'ogaki', driveFolderId: 'f-ogaki' });
    expect(ctx.regionRepo.docs.has('hacked')).toBe(false);
  });
});
