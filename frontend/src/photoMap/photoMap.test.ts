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
  id, regionId: 'yurihonjo', driveFileId: 'd', originalFilename: name, title: '', mimeType: 'image/jpeg', latitude: 39, longitude: 140,
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

describe('PhotoViewer original image', () => {
  const photos = [photo('a'), photo('b')];
  const setup = () =>
    mount(
      createElement(PhotoViewer, {
        photos,
        index: 0,
        imageUrl: (p: Photo) => `https://api.test/${p.id}/thumbnail`,
        originalUrl: (p: Photo) => `https://api.test/${p.id}/original`,
        formatDate: (): string => '',
        onIndexChange: vi.fn(),
        onClose: vi.fn(),
      }),
    );
  const srcs = (host: HTMLElement) => [...host.querySelectorAll('img')].map((i) => i.getAttribute('src'));

  it('requests the original, shows a loading indicator and the thumbnail meanwhile', () => {
    const { host, unmount } = setup();
    expect(srcs(host)).toEqual(['https://api.test/a/original', 'https://api.test/a/thumbnail']);
    expect(host.querySelector('.pmap-viewer-loading')).not.toBeNull();
    unmount();
  });

  it('shows only the original once it has loaded', () => {
    const { host, unmount } = setup();
    act(() => void host.querySelector('img')!.dispatchEvent(new Event('load')));
    expect(host.querySelector('.pmap-viewer-loading')).toBeNull();
    expect(srcs(host)).toEqual(['https://api.test/a/original']);
    expect((host.querySelector('img') as HTMLImageElement).style.display).not.toBe('none');
    unmount();
  });

  it('falls back to the thumbnail when the original fails', () => {
    const { host, unmount } = setup();
    act(() => void host.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(srcs(host)).toEqual(['https://api.test/a/thumbnail']);
    expect(host.querySelector('.pmap-viewer-loading')).toBeNull();
    expect(host.querySelector('.pmap-viewer-missing')).toBeNull();
    unmount();
  });

  it('shows a message only when both original and thumbnail fail', () => {
    const { host, unmount } = setup();
    act(() => void host.querySelectorAll('img')[0]!.dispatchEvent(new Event('error')));
    act(() => void host.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(host.querySelector('.pmap-viewer-missing')).not.toBeNull();
    unmount();
  });
});

describe('PhotoViewer rename and delete', () => {
  const photos = [photo('a'), photo('b', 'IMG_9.HEIC')];
  const setup = (over: Record<string, unknown> = {}, list: Photo[] = photos) => {
    const onRename = vi.fn(async () => undefined);
    const onDelete = vi.fn(async () => undefined);
    const onClose = vi.fn();
    const m = mount(
      createElement(PhotoViewer, {
        photos: list,
        index: 1,
        imageUrl: () => null,
        formatDate: (): string => '',
        onIndexChange: vi.fn(),
        onClose,
        canManage: () => true,
        onRename,
        onDelete,
        ...over,
      } as never),
    );
    return { ...m, onRename, onDelete, onClose };
  };
  const button = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement | undefined;
  const click = (el: HTMLElement | undefined) => act(() => el!.click());
  const settle = () => act(async () => { await Promise.resolve(); });
  const type = (input: HTMLInputElement, value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

  it('hides the actions from people who cannot manage the photo', () => {
    const { host, unmount } = setup({ canManage: () => false });
    expect(button(host, '名前を変更')).toBeUndefined();
    expect(button(host, '削除')).toBeUndefined();
    unmount();
  });

  it('shows the display title when set and falls back to the file name otherwise', () => {
    const titled = setup({}, [{ ...photos[0]!, title: '調査地点A' }, photos[1]!]);
    titled.unmount();
    const one = setup({ index: 0 }, [{ ...photos[0]!, title: '調査地点A' }]);
    expect(one.host.querySelector('.pmap-viewer-name')?.textContent).toBe('調査地点A');
    one.unmount();
    const plain = setup();
    expect(plain.host.querySelector('.pmap-viewer-name')?.textContent).toBe('IMG_9.HEIC');
    plain.unmount();
  });

  it('renames: prefilled input, saves once, and rejects an empty name on the server side call', async () => {
    const { host, onRename, unmount } = setup();
    click(button(host, '名前を変更'));
    const input = host.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('IMG_9.HEIC');
    type(input, '新しい名前');
    act(() => void host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await settle();
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }), '新しい名前');
    expect(host.querySelector('input')).toBeNull();
    unmount();
  });

  it('shows the failure and keeps the editor open when saving fails', async () => {
    const { host, unmount } = setup({ onRename: vi.fn(async () => { throw new Error('名前を変更できませんでした'); }) });
    click(button(host, '名前を変更'));
    act(() => void host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await settle();
    expect(host.querySelector('[role=alert]')?.textContent).toBe('名前を変更できませんでした');
    expect(host.querySelector('input')).not.toBeNull();
    unmount();
  });

  it('asks for confirmation naming the photo, and cancelling changes nothing', () => {
    const { host, onDelete, unmount } = setup();
    click(button(host, '削除'));
    const dialog = host.querySelector('[role=alertdialog]')!;
    expect(dialog.textContent).toContain('IMG_9.HEIC');
    expect(dialog.textContent).toContain('Google Drive');
    expect(onDelete).not.toHaveBeenCalled();
    click(button(host, 'キャンセル'));
    expect(host.querySelector('[role=alertdialog]')).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
    unmount();
  });

  it('deletes only after confirming, and blocks double submission while running', async () => {
    let finish!: () => void;
    const onDelete = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { host, unmount } = setup({ onDelete });
    click(button(host, '削除'));
    click(button(host, '削除する'));
    click(button(host, '削除中…'));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(button(host, '削除中…')!.disabled).toBe(true);
    await act(async () => { finish(); await Promise.resolve(); });
    unmount();
  });

  it('shows the error inside the confirmation and stays open when deletion fails', async () => {
    const { host, unmount } = setup({ onDelete: vi.fn(async () => { throw new Error('削除に失敗しました'); }) });
    click(button(host, '削除'));
    click(button(host, '削除する'));
    await settle();
    expect(host.querySelector('[role=alertdialog] [role=alert]')?.textContent).toBe('削除に失敗しました');
    expect(button(host, '削除する')!.disabled).toBe(false);
    unmount();
  });

  it('Escape cancels the confirmation instead of closing the viewer, and arrows do not navigate while editing', () => {
    const onIndexChange = vi.fn();
    const { host, onClose, unmount } = setup({ onIndexChange });
    click(button(host, '削除'));
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' })));
    expect(onIndexChange).not.toHaveBeenCalled();
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(host.querySelector('[role=alertdialog]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(onClose).toHaveBeenCalledTimes(1);
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
