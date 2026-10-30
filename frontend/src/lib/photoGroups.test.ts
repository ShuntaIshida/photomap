import { describe, expect, it } from 'vitest';
import type { Photo } from '../data';
import {
  clampIndex,
  clusterMarkerSize,
  createPhotoCountLabel,
  diffGroups,
  groupPhotosByLocation,
  groupSignature,
  pickRepresentativePhoto,
  sortPhotosDescByTakenAt,
  swipeDirection,
  toPhotoPoint,
  type PhotoPoint,
} from './photoGroups';

let seq = 0;
function photo(over: Partial<Photo> & { at?: number | null } = {}): Photo {
  const { at, ...rest } = over;
  const id = rest.id ?? `p${++seq}`;
  return {
    id,
    regionId: 'yurihonjo',
    driveFileId: `d-${id}`,
    originalFilename: `${id}.jpg`,
    title: '',
    mimeType: 'image/jpeg',
    latitude: 39.3853,
    longitude: 140.0488,
    capturedAt: at === null ? null : new Date(at ?? 1_700_000_000_000),
    capturedAtTimeZoneKnown: true,
    uploadedAt: new Date(1_800_000_000_000),
    uploaderUid: 'u',
    uploaderName: 'User',
    width: null,
    height: null,
    hasGps: true,
    locationSource: 'exif',
    ...rest,
  };
}
const point = (over: Parameters<typeof photo>[0] = {}) => toPhotoPoint(photo(over))!;

describe('toPhotoPoint', () => {
  it('uses the capture time, falls back to the upload time, then 0', () => {
    expect(point({ at: 5000 }).takenAtMs).toBe(5000);
    expect(point({ at: null }).takenAtMs).toBe(1_800_000_000_000);
    expect(toPhotoPoint(photo({ at: null, uploadedAt: null }))?.takenAtMs).toBe(0);
  });

  it('drops photos without GPS (they stay in the list but not on the map)', () => {
    expect(toPhotoPoint(photo({ hasGps: false, latitude: null, longitude: null }))).toBeNull();
    expect(toPhotoPoint(photo({ latitude: null }))).toBeNull();
  });
});

describe('pickRepresentativePhoto (newest capture time)', () => {
  it('chooses the photo taken most recently', () => {
    const photos = [point({ id: 'old', at: 1000 }), point({ id: 'new', at: 9000 }), point({ id: 'mid', at: 5000 })];
    expect(pickRepresentativePhoto(photos)?.id).toBe('new');
  });

  it('returns undefined for an empty list and the first on ties', () => {
    expect(pickRepresentativePhoto([])).toBeUndefined();
    expect(pickRepresentativePhoto([point({ id: 'a', at: 1 }), point({ id: 'b', at: 1 })])?.id).toBe('a');
  });
});

describe('groupPhotosByLocation (same GPS coordinate)', () => {
  it('puts photos with the same coordinate (5 decimals) in one group, newest first', () => {
    const groups = groupPhotosByLocation([
      point({ id: 'a', at: 1000, latitude: 39.123451, longitude: 140.1 }),
      point({ id: 'b', at: 3000, latitude: 39.123454, longitude: 140.1 }),
      point({ id: 'c', at: 2000, latitude: 39.5, longitude: 140.2 }),
    ]);
    expect(groups).toHaveLength(2);
    const same = groups.find((g) => g.photos.length === 2)!;
    expect(same.photos.map((p) => p.id)).toEqual(['b', 'a']);
  });

  it('keeps every photo at an identical coordinate reachable (no photo is dropped)', () => {
    const many = Array.from({ length: 25 }, (_, i) => point({ id: `s${i}`, at: i, latitude: 39.1, longitude: 140.1 }));
    const [group] = groupPhotosByLocation(many);
    expect(group!.photos).toHaveLength(25);
    expect(new Set(group!.photos.map((p) => p.id)).size).toBe(25);
  });
});

describe('sortPhotosDescByTakenAt', () => {
  it('is newest-first and deterministic on ties', () => {
    const sorted = sortPhotosDescByTakenAt([point({ id: 'b', at: 1 }), point({ id: 'a', at: 1 }), point({ id: 'c', at: 2 })]);
    expect(sorted.map((p) => p.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('cluster appearance rules (same as nagareyama-photo)', () => {
  it('shows 99+ for large counts', () => {
    expect(createPhotoCountLabel(2)).toBe('2');
    expect(createPhotoCountLabel(99)).toBe('99');
    expect(createPhotoCountLabel(100)).toBe('99+');
  });

  it('enlarges clusters as they grow (52 / 56 / 60)', () => {
    expect(clusterMarkerSize(2)).toBe(52);
    expect(clusterMarkerSize(40)).toBe(52);
    expect(clusterMarkerSize(41)).toBe(56);
    expect(clusterMarkerSize(200)).toBe(56);
    expect(clusterMarkerSize(201)).toBe(60);
  });
});

describe('diffGroups (avoid regenerating markers)', () => {
  const groups = (pts: PhotoPoint[]) => groupPhotosByLocation(pts);
  const sigs = (gs: ReturnType<typeof groups>) => new Map(gs.map((g) => [g.key, groupSignature(g)]));

  it('creates every marker on the first render', () => {
    const next = groups([point({ id: 'a', latitude: 1.1, longitude: 2.2 }), point({ id: 'b', latitude: 3.3, longitude: 4.4 })]);
    const d = diffGroups(new Map(), next);
    expect(d.add).toHaveLength(2);
    expect(d.remove).toHaveLength(0);
  });

  it('does nothing when the photo set is unchanged, even for a new array instance', () => {
    const make = () => groups(Array.from({ length: 500 }, (_, i) => point({ id: `n${i}`, latitude: 30 + i * 0.01, longitude: 130 })));
    const prev = sigs(make());
    const d = diffGroups(prev, make());
    expect(d).toEqual({ add: [], remove: [] });
  });

  it('only touches the group that changed when one photo is added', () => {
    const base = Array.from({ length: 300 }, (_, i) => point({ id: `n${i}`, latitude: 30 + i * 0.01, longitude: 130 }));
    const prev = sigs(groups(base));
    const withNew = groups([...base, point({ id: 'extra', latitude: 45, longitude: 140 })]);
    const d = diffGroups(prev, withNew);
    expect(d.add.map((g) => g.photos[0]!.id)).toEqual(['extra']);
    expect(d.remove).toEqual([]);
  });

  it('rebuilds just the affected group when a photo joins an existing coordinate', () => {
    const base = [point({ id: 'a', at: 1, latitude: 10, longitude: 20 }), point({ id: 'z', at: 1, latitude: 50, longitude: 60 })];
    const prev = sigs(groups(base));
    const next = groups([...base, point({ id: 'a2', at: 9, latitude: 10, longitude: 20 })]);
    const d = diffGroups(prev, next);
    expect(d.add).toHaveLength(1);
    expect(d.add[0]!.photos.map((p) => p.id)).toEqual(['a2', 'a']);
    expect(d.remove).toEqual(['10.00000,20.00000']);
  });

  it('removes groups whose photos disappear (e.g. a search filter)', () => {
    const base = [point({ id: 'a', latitude: 10, longitude: 20 }), point({ id: 'b', latitude: 50, longitude: 60 })];
    const prev = sigs(groups(base));
    const d = diffGroups(prev, groups([base[0]!]));
    expect(d.add).toEqual([]);
    expect(d.remove).toEqual(['50.00000,60.00000']);
  });
});

describe('viewer helpers', () => {
  it('detects swipe direction with a 40px threshold', () => {
    expect(swipeDirection(41)).toBe('prev');
    expect(swipeDirection(-41)).toBe('next');
    expect(swipeDirection(39)).toBeNull();
    expect(swipeDirection(-39)).toBeNull();
    expect(swipeDirection(0)).toBeNull();
  });

  it('clamps indexes', () => {
    expect(clampIndex(-3, 5)).toBe(0);
    expect(clampIndex(9, 5)).toBe(4);
    expect(clampIndex(2, 5)).toBe(2);
    expect(clampIndex(1, 0)).toBe(0);
  });
});
