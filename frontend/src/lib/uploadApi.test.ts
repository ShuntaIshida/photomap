import { describe, expect, it } from 'vitest';
import { describeUploadError, UploadError, uploadPhoto } from './uploadApi';

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function capture(response: Response | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (response instanceof Error) throw response;
    return response;
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const base = { apiBase: 'https://api.example.test', slug: 'yurihonjo', token: 'firebase-id-token', filename: 'IMG_1.heic' };
const file = () => new Blob(['original-bytes'], { type: 'image/heic' });
const thumb = () => new Blob(['thumb-bytes'], { type: 'image/jpeg' });

describe('uploadPhoto', () => {
  it('sends the Firebase ID token and only the file + thumbnail to the region URL', async () => {
    const { calls, fetchFn } = capture(ok({ photoId: 'yurihonjo-abc' }, 201));
    const r = await uploadPhoto({ ...base, file: file(), thumbnail: thumb(), fetchFn });
    expect(r.photoId).toBe('yurihonjo-abc');

    const call = calls[0]!;
    expect(call.url).toBe('https://api.example.test/regions/yurihonjo/photos');
    expect(call.init.method).toBe('POST');
    expect((call.init.headers as Record<string, string>).Authorization).toBe('Bearer firebase-id-token');

    const form = call.init.body as FormData;
    expect([...form.keys()].sort()).toEqual(['file', 'thumbnail']);
    expect((form.get('file') as File).name).toBe('IMG_1.heic');
  });

  it('never sends a Drive folder id, coordinates, or uploader id', async () => {
    const { calls, fetchFn } = capture(ok({ photoId: 'p' }, 201));
    await uploadPhoto({ ...base, file: file(), thumbnail: thumb(), fetchFn });
    const form = calls[0]!.init.body as FormData;
    for (const forbidden of ['folderId', 'parentId', 'driveFolderId', 'latitude', 'longitude', 'uploaderUid', 'regionId']) {
      expect(form.has(forbidden)).toBe(false);
    }
  });

  it('url-encodes the slug', async () => {
    const { calls, fetchFn } = capture(ok({ photoId: 'p' }, 201));
    await uploadPhoto({ ...base, slug: 'a/b', file: file(), thumbnail: thumb(), fetchFn });
    expect(calls[0]!.url).toBe('https://api.example.test/regions/a%2Fb/photos');
  });

  it.each([
    [422, 'no_gps'],
    [409, 'duplicate_photo'],
    [413, 'file_too_large'],
    [429, 'rate_limited'],
    [503, 'drive_scope_insufficient'],
  ])('maps HTTP %i to the server error code %s', async (status, code) => {
    const { fetchFn } = capture(ok({ error: { code } }, status));
    await expect(uploadPhoto({ ...base, file: file(), thumbnail: thumb(), fetchFn })).rejects.toMatchObject({ code, status });
  });

  it('reports network failures and non-JSON errors', async () => {
    const net = capture(new TypeError('failed to fetch'));
    await expect(uploadPhoto({ ...base, file: file(), thumbnail: thumb(), fetchFn: net.fetchFn })).rejects.toMatchObject({ code: 'network' });
    const html = capture(new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(uploadPhoto({ ...base, file: file(), thumbnail: thumb(), fetchFn: html.fetchFn })).rejects.toMatchObject({ code: 'unknown', status: 502 });
  });

  it('rejects a success response without a photo id', async () => {
    const { fetchFn } = capture(ok({}, 201));
    await expect(uploadPhoto({ ...base, file: file(), thumbnail: thumb(), fetchFn })).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('describeUploadError', () => {
  it('gives actionable Japanese messages', () => {
    expect(describeUploadError(new UploadError('no_gps', 422))).toContain('GPS');
    expect(describeUploadError(new UploadError('drive_scope_insufficient', 503))).toContain('再認可');
    expect(describeUploadError(new UploadError('something_new', 500))).toBe('アップロードに失敗しました');
    expect(describeUploadError(new Error('decode failed'))).toContain('処理に失敗');
  });
});
