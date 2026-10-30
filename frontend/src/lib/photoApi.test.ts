import { describe, expect, it } from 'vitest';
import { deletePhoto, describePhotoError, PhotoApiError, renamePhoto, validateTitle } from './photoApi';

const respond = (r: Response | Error) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (r instanceof Error) throw r;
    return r.clone();
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const base = { apiBase: 'https://api.test', photoId: 'yurihonjo-' + 'a'.repeat(32), token: 'id-token' };

describe('validateTitle', () => {
  it('trims, and rejects empty, blank and over-long titles', () => {
    expect(validateTitle('  調査地 A ')).toBe('調査地 A');
    expect(() => validateTitle('')).toThrow();
    expect(() => validateTitle('   ')).toThrow();
    expect(validateTitle('あ'.repeat(100))).toHaveLength(100);
    expect(() => validateTitle('あ'.repeat(101))).toThrow();
  });
});

describe('renamePhoto / deletePhoto', () => {
  it('sends only the title with the ID token to the photo URL', async () => {
    const { calls, fetchFn } = respond(json({ title: 'New' }));
    expect(await renamePhoto({ ...base, fetchFn }, ' New ')).toBe('New');
    const c = calls[0]!;
    expect(c.url).toBe(`https://api.test/photos/${base.photoId}`);
    expect(c.init.method).toBe('PATCH');
    expect((c.init.headers as Record<string, string>).Authorization).toBe('Bearer id-token');
    expect(JSON.parse(c.init.body as string)).toEqual({ title: 'New' });
  });

  it('does not call the API for an invalid title', async () => {
    const { calls, fetchFn } = respond(json({ title: 'x' }));
    await expect(renamePhoto({ ...base, fetchFn }, '   ')).rejects.toBeInstanceOf(PhotoApiError);
    expect(calls).toHaveLength(0);
  });

  it('deletes by photo ID only', async () => {
    const { calls, fetchFn } = respond(new Response(null, { status: 204 }));
    await deletePhoto({ ...base, fetchFn });
    expect(calls[0]!.init.method).toBe('DELETE');
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it('surfaces server error codes and network failures with readable messages', async () => {
    const denied = respond(json({ error: { code: 'not_photo_owner' } }, 403));
    const err = await deletePhoto({ ...base, fetchFn: denied.fetchFn }).catch((e) => e);
    expect(err).toMatchObject({ code: 'not_photo_owner', status: 403 });
    expect(describePhotoError(err, 'fallback')).toContain('投稿者本人または管理者');
    const net = await deletePhoto({ ...base, fetchFn: respond(new TypeError('x')).fetchFn }).catch((e) => e);
    expect(net.code).toBe('network');
    expect(describePhotoError(new Error('boom'), 'fallback')).toBe('fallback');
  });
});
