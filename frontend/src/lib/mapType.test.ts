import { describe, expect, it } from 'vitest';
import { isMapTypeId, loadMapType, MAP_TYPE_IDS, MAP_TYPE_STORAGE_KEY, saveMapType } from './mapType';

const memory = (initial: Record<string, string> = {}) => {
  const data = { ...initial };
  return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v) };
};

describe('mapType', () => {
  it('supports the four Google Maps types', () => {
    expect([...MAP_TYPE_IDS]).toEqual(['roadmap', 'satellite', 'hybrid', 'terrain']);
  });

  it('defaults to roadmap when nothing valid is stored', () => {
    expect(loadMapType(memory())).toBe('roadmap');
    expect(loadMapType(memory({ [MAP_TYPE_STORAGE_KEY]: 'bogus' }))).toBe('roadmap');
  });

  it('round-trips each type through storage', () => {
    for (const id of MAP_TYPE_IDS) {
      const s = memory();
      saveMapType(id, s);
      expect(loadMapType(s)).toBe(id);
    }
  });

  it('ignores invalid values and storage failures', () => {
    const s = memory();
    saveMapType('bogus', s);
    expect(s.data).toEqual({});
    expect(isMapTypeId(undefined)).toBe(false);
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(loadMapType(broken)).toBe('roadmap');
    expect(() => saveMapType('hybrid', broken)).not.toThrow();
  });
});
