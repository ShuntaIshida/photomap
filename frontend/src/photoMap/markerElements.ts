import { createPhotoCountLabel } from '../lib/photoGroups';

export interface MarkerElementOptions {
  name: string;
  thumbnailUrl: string | null;
  count: number;
  size: number;
  cluster?: boolean;
}

/**
 * 地図上の写真マーカー（nagareyama-photoのcreateMarkerContentの移植）。
 * 白い枠つきの代表写真サムネイルで、2枚以上なら重なった台紙と右上の枚数バッジを付ける。
 */
export function createMarkerElement({ name, thumbnailUrl, count, size, cluster = false }: MarkerElementOptions): HTMLDivElement {
  const root = document.createElement('div');
  const classes = ['pmap-marker'];
  if (count > 1) classes.push('pmap-stack');
  if (cluster) classes.push('pmap-cluster');
  root.className = classes.join(' ');
  root.style.setProperty('--marker-size', `${size}px`);

  if (thumbnailUrl) {
    const img = document.createElement('img');
    img.src = thumbnailUrl;
    img.alt = name;
    img.loading = 'lazy';
    img.decoding = 'async';
    root.append(img);
  } else {
    // サムネイル未登録の写真。枠だけのプレースホルダーにする。
    const empty = document.createElement('span');
    empty.className = 'pmap-noimg';
    root.append(empty);
  }

  if (count > 1) {
    const badge = document.createElement('span');
    badge.className = 'pmap-count';
    badge.textContent = createPhotoCountLabel(count);
    root.append(badge);
  }
  return root;
}

export const SELECTED_CLASS = 'is-selected';

/** 選択状態の見た目（赤い枠・拡大）。要素は作り直さずクラスだけ切り替える。 */
export function setElementSelected(element: HTMLElement, selected: boolean): void {
  element.classList.toggle(SELECTED_CLASS, selected);
}
