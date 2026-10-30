import { photoName, type Photo } from '../data';

export interface ClusterSheetProps {
  photos: readonly Photo[];
  thumbnailUrl: (photo: Photo) => string | null;
  onPick: (index: number) => void;
  onClose: () => void;
}

/**
 * クラスタ（同一座標を含む）内の写真一覧を下から出すシート（nagareyama-photoのopenClusterSheetの移植）。
 * 写真は撮影日時の新しい順で、選ぶと全画面ビューアでその続きから連続して閲覧できる。
 */
export default function ClusterSheet({ photos, thumbnailUrl, onPick, onClose }: ClusterSheetProps) {
  return (
    <div className="pmap-sheet">
      <div className="pmap-sheet-backdrop" onClick={onClose} />
      <div className="pmap-sheet-panel" role="dialog" aria-modal="true" aria-label="クラスタ内写真一覧">
        <div className="pmap-sheet-head">
          <h3>この周辺の写真 {photos.length}件</h3>
          <button className="pmap-sheet-close" type="button" onClick={onClose} aria-label="閉じる">×</button>
        </div>
        <div className="pmap-sheet-grid">
          {photos.map((photo, i) => {
            const src = thumbnailUrl(photo);
            return (
              <button key={photo.id} className="pmap-sheet-item" type="button" onClick={() => onPick(i)}>
                {src ? <img src={src} alt={photoName(photo)} loading="lazy" decoding="async" /> : <span className="pmap-sheet-noimg" />}
                <span className="pmap-sheet-item-name">{photoName(photo)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
