import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { DRIVE_SCOPE } from '../src/services/googleOAuth.js';
import { build } from './helpers.js';

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function startFlow(ctx: ReturnType<typeof build>) {
  const res = await request(ctx.app).post('/admin/drive/oauth/start').set(bearer('admin-token'));
  const state = new URL(res.body.authorizationUrl).searchParams.get('state')!;
  return { res, state };
}

describe('public / admin separation', () => {
  it('GET /health is public', async () => {
    const res = await request(build().app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /regions is public and needs no token', async () => {
    const ctx = build();
    await ctx.tokens.save('rt');
    ctx.gateway.folders = [{ id: 'f1', name: 'yurihonjo' }];
    const res = await request(ctx.app).get('/regions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ regions: [{ slug: 'yurihonjo' }] });
  });

  it('GET /regions returns 503 drive_not_authorized before consent', async () => {
    const res = await request(build().app).get('/regions');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('drive_not_authorized');
  });

  it('GET /regions returns only slugs (no folder IDs) for valid folders', async () => {
    const ctx = build();
    await ctx.tokens.save('rt');
    ctx.gateway.folders = [
      { id: 'f1', name: 'yurihonjo' },
      { id: 'f2', name: 'nikaho' },
      { id: 'f3', name: 'Not A Slug' },
    ];
    const res = await request(ctx.app).get('/regions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ regions: [{ slug: 'nikaho' }, { slug: 'yurihonjo' }] });
  });

  it('caches the region list to protect Drive quota', async () => {
    const ctx = build();
    await ctx.tokens.save('rt');
    await request(ctx.app).get('/regions');
    await request(ctx.app).get('/regions');
    expect(ctx.gateway.calls).toBe(1);
  });

  it.each([
    ['post', '/admin/drive/oauth/start'],
    ['get', '/admin/drive/status'],
    ['get', '/admin/drive/folders'],
  ] as const)('%s %s rejects anonymous (401) and non-admin (403)', async (method, path) => {
    const { app } = build();
    expect((await request(app)[method](path)).status).toBe(401);
    expect((await request(app)[method](path).set(bearer('user-token'))).status).toBe(403);
  });

  it('admin can list folders including folder IDs and ignored entries', async () => {
    const ctx = build();
    await ctx.tokens.save('rt');
    ctx.gateway.folders = [
      { id: 'f1', name: 'yurihonjo' },
      { id: 'f2', name: 'BadName' },
    ];
    const res = await request(ctx.app).get('/admin/drive/folders').set(bearer('admin-token'));
    expect(res.status).toBe(200);
    expect(res.body.regions).toEqual([{ slug: 'yurihonjo', driveFolderId: 'f1' }]);
    expect(res.body.ignored).toEqual([{ name: 'BadName', reason: 'invalid_slug' }]);
  });

  it('status never exposes tokens and reports write access', async () => {
    const ctx = build();
    await ctx.tokens.save('super-secret-refresh');
    const res = await request(ctx.app).get('/admin/drive/status').set(bearer('admin-token'));
    expect(res.body.authorized).toBe(true);
    expect(res.body.writeAccess).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('super-secret-refresh');
    ctx.gateway.grantedScopes = async () => ['https://www.googleapis.com/auth/drive.metadata.readonly'];
    const old = await request(ctx.app).get('/admin/drive/status').set(bearer('admin-token'));
    expect(old.body.writeAccess).toBe(false);
  });
});

describe('OAuth authorization code flow', () => {
  it('start returns a URL with an unguessable state and PKCE challenge', async () => {
    const { res } = await startFlow(build());
    expect(res.status).toBe(200);
    const url = new URL(res.body.authorizationUrl);
    expect(url.searchParams.get('state')!.length).toBeGreaterThanOrEqual(43);
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('completes the flow, stores the refresh token and uses the PKCE verifier', async () => {
    const ctx = build();
    const { state } = await startFlow(ctx);
    const res = await request(ctx.app).get('/oauth/google/callback').query({ code: 'auth-code', state });
    expect(res.status).toBe(200);
    expect(await ctx.tokens.get()).toBe('refresh-token-value');
    expect(ctx.google.lastVerifier).toBeTruthy();
    expect(res.text).not.toContain('refresh-token-value');
  });

  it('state is single-use (replay rejected)', async () => {
    const ctx = build();
    const { state } = await startFlow(ctx);
    await request(ctx.app).get('/oauth/google/callback').query({ code: 'c', state });
    await ctx.tokens.save('reset');
    ctx.google.exchange = { ...ctx.google.exchange, refreshToken: 'attacker-token' };
    const replay = await request(ctx.app).get('/oauth/google/callback').query({ code: 'c', state });
    expect(replay.status).toBe(400);
    expect(await ctx.tokens.get()).toBe('reset');
  });

  it('rejects forged or missing state/code (CSRF)', async () => {
    const ctx = build();
    ctx.google.exchange = { ...ctx.google.exchange, refreshToken: 'attacker-token' };
    expect((await request(ctx.app).get('/oauth/google/callback').query({ code: 'c', state: 'forged' })).status).toBe(400);
    expect((await request(ctx.app).get('/oauth/google/callback').query({ code: 'c' })).status).toBe(400);
    expect((await request(ctx.app).get('/oauth/google/callback').query({ state: 's' })).status).toBe(400);
    expect((await request(ctx.app).get('/oauth/google/callback').query({ error: 'access_denied', state: 's' })).status).toBe(400);
    expect(await ctx.tokens.get()).toBeNull();
  });

  it('rejects when the initiating user lost admin before the callback', async () => {
    const ctx = build();
    const { state } = await startFlow(ctx);
    ctx.auth.admins.clear();
    const res = await request(ctx.app).get('/oauth/google/callback').query({ code: 'c', state });
    expect(res.status).toBe(403);
    expect(await ctx.tokens.get()).toBeNull();
  });

  it('rejects an unexpected or unverified Google account', async () => {
    for (const exchange of [
      { refreshToken: 'x', email: 'other@example.com', emailVerified: true, scopes: [DRIVE_SCOPE] },
      { refreshToken: 'x', email: 'owner@example.ac.jp', emailVerified: false, scopes: [DRIVE_SCOPE] },
      { refreshToken: 'x', email: null, emailVerified: false, scopes: [DRIVE_SCOPE] },
    ]) {
      const ctx = build();
      ctx.google.exchange = exchange;
      const { state } = await startFlow(ctx);
      const res = await request(ctx.app).get('/oauth/google/callback').query({ code: 'c', state });
      expect(res.status).toBe(403);
      expect(await ctx.tokens.get()).toBeNull();
    }
  });

  it('does not store a token when the Drive permission was unchecked on the consent screen', async () => {
    const ctx = build();
    ctx.google.exchange = { ...ctx.google.exchange, scopes: ['openid', 'email'] };
    const { state } = await startFlow(ctx);
    const res = await request(ctx.app).get('/oauth/google/callback').query({ code: 'c', state });
    expect(res.status).toBe(400);
    expect(await ctx.tokens.get()).toBeNull();
  });

  it('fails when Google returns no refresh token', async () => {
    const ctx = build();
    ctx.google.exchange = { ...ctx.google.exchange, refreshToken: null };
    const { state } = await startFlow(ctx);
    const res = await request(ctx.app).get('/oauth/google/callback').query({ code: 'c', state });
    expect(res.status).toBe(400);
  });
});

describe('CORS', () => {
  it('allows GitHub Pages and localhost origins', async () => {
    const { app } = build();
    for (const origin of ['https://shuntaishida.github.io', 'http://localhost:5173']) {
      const res = await request(app).options('/regions').set('Origin', origin).set('Access-Control-Request-Method', 'GET');
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    }
  });

  it('does not grant CORS to other origins', async () => {
    const { app } = build();
    for (const origin of ['https://evil.example', 'https://shuntaishida.github.io.evil.example', 'null']) {
      const res = await request(app).get('/health').set('Origin', origin);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
  });
});
