import { useEffect, useRef, useState } from 'react';
import type { Photo } from '../data';
import { clampIndex, swipeDirection } from '../lib/photoGroups';

export interface PhotoViewerProps {
  photos: readonly Photo[];
  index: number;
  /** 表示する画像のURL。画像が無い写真はnull。 */
  imageUrl: (photo: Photo) => string | null;
  formatDate: (photo: Photo) => string;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

/**
 * 全画面の写真ビューア（nagareyama-photoのopenPhotoModal/updateModalContentの移植）。
 * 前へ・次へボタン、キーボードの左右、スマートフォンの左右スワイプ（40px以上）で切り替える。
 */
export default function PhotoViewer({ photos, index, imageUrl, formatDate, onIndexChange, onClose }: PhotoViewerProps) {
  const current = photos[clampIndex(index, photos.length)];
  const touchStartX = useRef(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [failedId, setFailedId] = useState<string | null>(null);

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
  const src = imageUrl(current);

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
          {src && failedId !== current.id ? (
            <img
              key={current.id}
              className="pmap-viewer-image"
              src={src}
              alt={current.originalFilename}
              onError={() => setFailedId(current.id)}
              onTouchStart={(e) => {
                touchStartX.current = e.changedTouches[0]?.clientX ?? 0;
              }}
              onTouchEnd={(e) => {
                const dir = swipeDirection((e.changedTouches[0]?.clientX ?? 0) - touchStartX.current);
                if (dir === 'prev') go(-1);
                else if (dir === 'next') go(1);
              }}
            />
          ) : (
            <p className="pmap-viewer-missing">この写真の画像を表示できません</p>
          )}
        </div>
      </div>
    </div>
  );
}
