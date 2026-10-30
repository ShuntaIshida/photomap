import { describe, expect, it } from 'vitest';
import {
  buildRegions,
  loadLastKnownSlugs,
  parseSlugResponse,
  resolveSlugs,
  saveLastKnownSlugs,
  type Region,
} from './regionList';

const memoryStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
};

describe('parseSlugResponse', () => {
  it('extracts valid unique slugs', () => {
    expect(parseSlugResponse({ regions: [{ slug: 'nikaho' }, { slug: 'yurihonjo' }, { slug: 'nikaho' }, { slug: 'Bad Slug' }, {}] })).toEqual([
      'nikaho',
      'yurihonjo',
    ]);
  });

  it('treats an empty list as a valid (empty) result', () => {
    expect(parseSlugResponse({ regions: [] })).toEqual([]);
  });

  it('throws on malformed responses so the caller can fall back', () => {
    expect(() => parseSlugResponse(null)).toThrow();
    expect(() => parseSlugResponse({})).toThrow();
    expect(() => parseSlugResponse({ error: { code: 'x' } })).toThrow();
  });
});

describe('buildRegions', () => {
  it('uses the fixed display names for known regions', () => {
    const regions = buildRegions(['nikaho', 'yurihonjo'], []);
    expect(regions.map((r) => [r.slug, r.name])).toEqual([
      ['yurihonjo', '由利本荘'],
      ['nikaho', 'にかほ'],
    ]);
  });

  it('does not create regions for Firestore documents whose folder is absent from Drive (akita / noshiro)', () => {
    const stale: Region[] = ['akita', 'noshiro'].map((slug, i) => ({
      id: slug, slug, name: slug, prefecture: '', defaultCenter: { lat: 1, lng: 2 }, defaultZoom: 10, sortOrder: i, configured: true,
    }));
    const regions = buildRegions(['nikaho', 'yurihonjo'], stale);
    expect(regions.map((r) => r.slug)).toEqual(['yurihonjo', 'nikaho']);
  });

  it('uses Firestore metadata for new folders, else falls back to the folder name', () => {
    const meta: Region[] = [
      { id: 'kisakata', slug: 'kisakata', name: '象潟', prefecture: '秋田県', defaultCenter: { lat: 39.2, lng: 139.9 }, defaultZoom: 11, sortOrder: 3, configured: true },
    ];
    const regions = buildRegions(['kisakata', 'newplace'], meta);
    expect(regions.find((r) => r.slug === 'kisakata')?.name).toBe('象潟');
    const fallback = regions.find((r) => r.slug === 'newplace')!;
    expect(fallback.name).toBe('newplace');
    expect(fallback.defaultCenter.lat).toBeGreaterThan(0);
  });

  it('shows Ogaki in Gifu (not Akita) from the built-in default', () => {
    const ogaki = buildRegions(['ogaki'], []).find((r) => r.slug === 'ogaki')!;
    expect(ogaki.name).toBe('大垣');
    expect(ogaki.defaultCenter.lat).toBeCloseTo(35.36, 1);
    expect(ogaki.defaultCenter.lng).toBeCloseTo(136.61, 1);
  });

  it('prefers the Firestore settings over the built-in defaults, keeping the order', () => {
    const meta: Region[] = [
      { id: 'ogaki', slug: 'ogaki', name: '大垣市', prefecture: '', defaultCenter: { lat: 35.4, lng: 136.7 }, defaultZoom: 14, sortOrder: 999, configured: true },
    ];
    const regions = buildRegions(['ogaki', 'yurihonjo'], meta);
    expect(regions.map((r) => r.slug)).toEqual(['yurihonjo', 'ogaki']);
    expect(regions[1]).toMatchObject({ name: '大垣市', defaultZoom: 14, prefecture: '岐阜県', defaultCenter: { lat: 35.4, lng: 136.7 } });
  });

  it('shows a wide, clearly unconfigured placeholder for a new folder instead of guessing a place', () => {
    const r = buildRegions(['newplace'], [])[0]!;
    expect(r.configured).toBe(false);
    expect(r.defaultZoom).toBeLessThanOrEqual(6);
    expect(r.name).toBe('newplace');
  });

  it('returns an empty list for no slugs', () => {
    expect(buildRegions([], [])).toEqual([]);
  });
});

describe('last-known slug cache', () => {
  it('round-trips valid slugs', () => {
    const s = memoryStorage();
    saveLastKnownSlugs(s, ['nikaho', 'yurihonjo']);
    expect(loadLastKnownSlugs(s)).toEqual(['nikaho', 'yurihonjo']);
  });

  it('ignores missing, corrupted or empty cache', () => {
    const s = memoryStorage();
    expect(loadLastKnownSlugs(s)).toBeNull();
    s.setItem('photomap.driveRegions.v1', '{not json');
    expect(loadLastKnownSlugs(s)).toBeNull();
    s.setItem('photomap.driveRegions.v1', JSON.stringify(['BAD', 3]));
    expect(loadLastKnownSlugs(s)).toBeNull();
    expect(loadLastKnownSlugs(undefined)).toBeNull();
  });
});

describe('resolveSlugs (which region URLs are valid)', () => {
  const API = 'https://api.example.test';
  const ok = (slugs: string[]) => async () => ({ ok: true, status: 200, json: async () => ({ regions: slugs.map((slug) => ({ slug })) }) });
  const fail = async () => {
    throw new TypeError('network down');
  };
  const status = (code: number) => async () => ({ ok: false, status: code, json: async () => ({}) });
  const isValid = (slugs: string[], slug: string) => buildRegions(slugs, []).some((r) => r.slug === slug);

  it('/yurihonjo and /nikaho are valid when both folders exist in Drive', async () => {
    const slugs = await resolveSlugs({ apiBase: API, fetchFn: ok(['yurihonjo', 'nikaho']) });
    expect(isValid(slugs, 'yurihonjo')).toBe(true);
    expect(isValid(slugs, 'nikaho')).toBe(true);
  });

  it('a URL whose folder is not in Drive is invalid', async () => {
    const slugs = await resolveSlugs({ apiBase: API, fetchFn: ok(['yurihonjo', 'nikaho']) });
    expect(isValid(slugs, 'akita')).toBe(false);
    expect(isValid(slugs, 'noshiro')).toBe(false);
    expect(isValid(slugs, 'does-not-exist')).toBe(false);
  });

  it('a newly created Drive folder becomes valid without any code change', async () => {
    const before = await resolveSlugs({ apiBase: API, fetchFn: ok(['yurihonjo', 'nikaho']) });
    expect(isValid(before, 'newplace')).toBe(false);
    const after = await resolveSlugs({ apiBase: API, fetchFn: ok(['yurihonjo', 'nikaho', 'newplace']) });
    expect(isValid(after, 'newplace')).toBe(true);
  });

  it('a deleted Drive folder becomes invalid on the next successful fetch', async () => {
    const slugs = await resolveSlugs({ apiBase: API, fetchFn: ok(['yurihonjo']) });
    expect(isValid(slugs, 'nikaho')).toBe(false);
  });

  it.each([
    ['network error', fail],
    ['HTTP 503', status(503)],
    ['HTTP 401', status(401)],
    ['malformed body', async () => ({ ok: true, status: 200, json: async () => ({ unexpected: true }) })],
  ])('on %s keeps the last known regions and does not overwrite the cache', async (_name, failing) => {
    const storage = memoryStorage();
    await resolveSlugs({ apiBase: API, fetchFn: ok(['yurihonjo', 'nikaho', 'newplace']), storage });
    const slugs = await resolveSlugs({ apiBase: API, fetchFn: failing, storage });
    expect(slugs).toEqual(['yurihonjo', 'nikaho', 'newplace']);
    expect(loadLastKnownSlugs(storage)).toEqual(['yurihonjo', 'nikaho', 'newplace']);
  });

  it('on failure with no cache, falls back to the built-in regions instead of an empty list', async () => {
    const slugs = await resolveSlugs({ apiBase: API, fetchFn: fail, storage: memoryStorage() });
    expect(slugs).toEqual(['yurihonjo', 'nikaho']);
  });

  it('without an API base URL only the built-in regions are valid', async () => {
    const slugs = await resolveSlugs({ apiBase: '', fetchFn: fail });
    expect(slugs).toEqual(['yurihonjo', 'nikaho']);
  });

  it('a successful but empty response means no valid regions', async () => {
    const storage = memoryStorage();
    await resolveSlugs({ apiBase: API, fetchFn: ok(['yurihonjo']), storage });
    const slugs = await resolveSlugs({ apiBase: API, fetchFn: ok([]), storage });
    expect(slugs).toEqual([]);
  });

  it('calls GET {apiBase}/regions without credentials', async () => {
    let called = '';
    await resolveSlugs({
      apiBase: API,
      fetchFn: async (url) => {
        called = url;
        return { ok: true, status: 200, json: async () => ({ regions: [] }) };
      },
    });
    expect(called).toBe(`${API}/regions`);
  });
});
