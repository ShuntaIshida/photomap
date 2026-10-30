import { useEffect, useRef, useState } from 'react';
import type { Photo } from '../data';
import { clampIndex, swipeDirection } from '../lib/photoGroups';

export interface PhotoViewerProps {
  photos: readonly Photo[];
  index: number;
  /** サムネイルのURL。原本の読み込み中の仮表示と、原本の取得に失敗したときの代替に使う。 */
  imageUrl: (photo: Photo) => string | null;
  /** 原本（HEICは表示用JPEG）のURL。 */
  originalUrl?: (photo: Photo) => string | null;
  formatDate: (photo: Photo) => string;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

/**
 * 全画面の写真ビューア（nagareyama-photoのopenPhotoModal/updateModalContentの移植）。
 * 前へ・次へボタン、キーボードの左右、スマートフォンの左右スワイプ（40px以上）で切り替える。
 */
export default function PhotoViewer({ photos, index, imageUrl, originalUrl, formatDate, onIndexChange, onClose }: PhotoViewerProps) {
  const current = photos[clampIndex(index, photos.length)];
  const touchStartX = useRef(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [originalLoadedId, setOriginalLoadedId] = useState<string | null>(null);
  const [originalFailedId, setOriginalFailedId] = useState<string | null>(null);
  const [thumbFailedId, setThumbFailedId] = useState<string | null>(null);

  const go = (delta: number) => {
    const next = index + delta;
    if (next < 0 || next > photos.length - 1) return;
    onIndexChange(next);
  };

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!current) return null;
  const thumbSrc = imageUrl(current);
  const originalSrc = originalUrl?.(current) ?? null;
  const showOriginal = !!originalSrc && originalFailedId !== current.id;
  const originalReady = originalLoadedId === current.id;
  const showThumb = !!thumbSrc && thumbFailedId !== current.id && (!showOriginal || !originalReady);
  const swipe = {
    onTouchStart: (e: React.TouchEvent) => {
      touchStartX.current = e.changedTouches[0]?.clientX ?? 0;
    },
    onTouchEnd: (e: React.TouchEvent) => {
      const dir = swipeDirection((e.changedTouches[0]?.clientX ?? 0) - touchStartX.current);
      if (dir === 'prev') go(-1);
      else if (dir === 'next') go(1);
    },
  };

  return (
    <div className="pmap-viewer" aria-hidden="false">
      <div className="pmap-viewer-backdrop" onClick={onClose} />
      <div className="pmap-viewer-dialog" role="dialog" aria-modal="true" aria-label="写真詳細">
        <button ref={closeRef} className="pmap-viewer-close" type="button" onClick={onClose} aria-label="閉じる">×</button>
        <button className="pmap-viewer-nav pmap-viewer-prev" type="button" onClick={() => go(-1)} disabled={index <= 0} aria-label="前の写真">‹</button>
        <button className="pmap-viewer-nav pmap-viewer-next" type="button" onClick={() => go(1)} disabled={index >= photos.length - 1} aria-label="次の写真">›</button>
        <div className="pmap-viewer-head">
          <h2 className="pmap-viewer-name">{current.originalFilename}</h2>
          <p className="pmap-viewer-taken">
            {formatDate(current)}
            {current.uploaderName && ` ・ ${current.uploaderName}`}
          </p>
          <p className="pmap-viewer-index">{index + 1} / {photos.length}</p>
        </div>
        <div className="pmap-viewer-stage">
          {showOriginal && (
            <img
              key={`original-${current.id}`}
              className="pmap-viewer-image"
              style={originalReady ? undefined : { display: 'none' }}
              src={originalSrc}
              alt={current.originalFilename}
              onLoad={() => setOriginalLoadedId(current.id)}
              onError={() => setOriginalFailedId(current.id)}
              {...swipe}
            />
          )}
          {showThumb && (
            <img
              key={`thumb-${current.id}`}
              className="pmap-viewer-image"
              src={thumbSrc}
              alt={current.originalFilename}
              onError={() => setThumbFailedId(current.id)}
              {...swipe}
            />
          )}
          {showOriginal && !originalReady && <p className="pmap-viewer-loading" role="status">原本を読み込み中…</p>}
          {!showOriginal && !showThumb && <p className="pmap-viewer-missing">この写真の画像を表示できません</p>}
        </div>
      </div>
    </div>
  );
}
