// @vitest-environment happy-dom
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Photo } from '../data';
import ClusterSheet from './ClusterSheet';
import { createMarkerElement, setElementSelected } from './markerElements';
import PhotoViewer from './PhotoViewer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const photo = (id: string, name = `${id}.jpg`): Photo => ({
  id, regionId: 'yurihonjo', driveFileId: 'd', originalFilename: name, mimeType: 'image/jpeg', latitude: 39, longitude: 140,
  capturedAt: new Date(1_700_000_000_000), capturedAtTimeZoneKnown: true, uploadedAt: null, uploaderUid: 'u', uploaderName: '投稿者',
  width: null, height: null, hasGps: true, locationSource: 'exif', thumbnailDriveFileId: 't',
});

describe('createMarkerElement', () => {
  it('renders the photo thumbnail itself in a framed marker (no orange dot)', () => {
    const el = createMarkerElement({ name: 'a.jpg', thumbnailUrl: 'https://api.test/photos/a/thumbnail', count: 1, size: 48 });
    expect(el.className).toBe('pmap-marker');
    expect(el.style.getPropertyValue('--marker-size')).toBe('48px');
    const img = el.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('https://api.test/photos/a/thumbnail');
    expect(img.loading).toBe('lazy');
    expect(el.querySelector('.pmap-count')).toBeNull();
  });

  it('adds the stacked look and a count badge for 2+ photos, 99+ for many', () => {
    const two = createMarkerElement({ name: 'a', thumbnailUrl: 'u', count: 2, size: 52, cluster: true });
    expect(two.className).toBe('pmap-marker pmap-stack pmap-cluster');
    expect(two.querySelector('.pmap-count')?.textContent).toBe('2');
    const many = createMarkerElement({ name: 'a', thumbnailUrl: 'u', count: 150, size: 56, cluster: true });
    expect(many.querySelector('.pmap-count')?.textContent).toBe('99+');
  });

  it('uses a placeholder when a photo has no thumbnail', () => {
    const el = createMarkerElement({ name: 'a', thumbnailUrl: null, count: 1, size: 48 });
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.pmap-noimg')).not.toBeNull();
  });

  it('toggles the selected state without recreating the element', () => {
    const el = createMarkerElement({ name: 'a', thumbnailUrl: 'u', count: 1, size: 48 });
    const img = el.querySelector('img');
    setElementSelected(el, true);
    expect(el.classList.contains('is-selected')).toBe(true);
    setElementSelected(el, false);
    expect(el.classList.contains('is-selected')).toBe(false);
    expect(el.querySelector('img')).toBe(img);
  });
});

function mount(node: ReturnType<typeof createElement>) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return { host, unmount: () => act(() => root.unmount()) };
}

describe('PhotoViewer', () => {
  const photos = [photo('a'), photo('b'), photo('c')];
  const setup = (index: number) => {
    const onIndexChange = vi.fn();
    const onClose = vi.fn();
    const m = mount(createElement(PhotoViewer, { photos, index, imageUrl: (p: Photo) => `https://api.test/${p.id}`, formatDate: (): string => '2026/10/3', onIndexChange, onClose }));
    return { ...m, onIndexChange, onClose };
  };

  it('shows the photo, position and uploader', () => {
    const { host, unmount } = setup(1);
    expect(host.querySelector('.pmap-viewer-name')?.textContent).toBe('b.jpg');
    expect(host.querySelector('.pmap-viewer-index')?.textContent).toBe('2 / 3');
    expect(host.querySelector('.pmap-viewer-taken')?.textContent).toContain('投稿者');
    expect(host.querySelector('img')?.getAttribute('src')).toBe('https://api.test/b');
    unmount();
  });

  it('goes to previous/next with the buttons and disables them at the ends', () => {
    const first = setup(0);
    expect((first.host.querySelector('.pmap-viewer-prev') as HTMLButtonElement).disabled).toBe(true);
    act(() => (first.host.querySelector('.pmap-viewer-next') as HTMLButtonElement).click());
    expect(first.onIndexChange).toHaveBeenCalledWith(1);
    first.unmount();

    const last = setup(2);
    expect((last.host.querySelector('.pmap-viewer-next') as HTMLButtonElement).disabled).toBe(true);
    act(() => (last.host.querySelector('.pmap-viewer-prev') as HTMLButtonElement).click());
    expect(last.onIndexChange).toHaveBeenCalledWith(1);
    last.unmount();
  });

  it('switches with the arrow keys', () => {
    const { onIndexChange, unmount } = setup(1);
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })));
    expect(onIndexChange).toHaveBeenLastCalledWith(2);
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' })));
    expect(onIndexChange).toHaveBeenLastCalledWith(0);
    unmount();
  });

  it('switches with left/right swipes of 40px or more and ignores short ones', () => {
    const { host, onIndexChange, unmount } = setup(1);
    const img = host.querySelector('img')!;
    const touch = (type: string, x: number) =>
      act(() => void img.dispatchEvent(Object.assign(new Event(type, { bubbles: true }), { changedTouches: [{ clientX: x }] })));
    touch('touchstart', 200); touch('touchend', 100); // 左へ100px -> 次
    expect(onIndexChange).toHaveBeenLastCalledWith(2);
    touch('touchstart', 100); touch('touchend', 200); // 右へ100px -> 前
    expect(onIndexChange).toHaveBeenLastCalledWith(0);
    onIndexChange.mockClear();
    touch('touchstart', 100); touch('touchend', 120); // 20px -> 無視
    expect(onIndexChange).not.toHaveBeenCalled();
    unmount();
  });

  it('can be closed with the close button and the backdrop', () => {
    const { host, onClose, unmount } = setup(0);
    act(() => (host.querySelector('.pmap-viewer-close') as HTMLButtonElement).click());
    act(() => (host.querySelector('.pmap-viewer-backdrop') as HTMLElement).click());
    expect(onClose).toHaveBeenCalledTimes(2);
    unmount();
  });
});

describe('ClusterSheet', () => {
  it('lists every photo of the cluster and opens the viewer at the picked one', () => {
    const list = Array.from({ length: 12 }, (_, i) => photo(`s${i}`));
    const onPick = vi.fn();
    const onClose = vi.fn();
    const { host, unmount } = mount(createElement(ClusterSheet, { photos: list, thumbnailUrl: (p: Photo) => `https://api.test/${p.id}`, onPick, onClose }));
    expect(host.querySelector('h3')?.textContent).toBe('この周辺の写真 12件');
    const items = host.querySelectorAll('.pmap-sheet-item');
    expect(items).toHaveLength(12);
    act(() => (items[5] as HTMLButtonElement).click());
    expect(onPick).toHaveBeenCalledWith(5);
    act(() => (host.querySelector('.pmap-sheet-close') as HTMLButtonElement).click());
    expect(onClose).toHaveBeenCalled();
    unmount();
  });
});
