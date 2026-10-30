import { useEffect, useRef, useState } from 'react';
import { photoName, type Photo } from '../data';
import { MAX_TITLE_LENGTH } from '../lib/photoApi';
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
  /** 名前変更・削除ができる写真か（投稿者本人または管理者）。権限はサーバーでも判定される。 */
  canManage?: (photo: Photo) => boolean;
  /** 失敗時は利用者向けメッセージのErrorを投げる。 */
  onRename?: (photo: Photo, title: string) => Promise<void>;
  onDelete?: (photo: Photo) => Promise<void>;
}

/**
 * 全画面の写真ビューア（nagareyama-photoのopenPhotoModal/updateModalContentの移植）。
 * 前へ・次へボタン、キーボードの左右、スマートフォンの左右スワイプ（40px以上）で切り替える。
 */
export default function PhotoViewer({ photos, index, imageUrl, originalUrl, formatDate, onIndexChange, onClose, canManage, onRename, onDelete }: PhotoViewerProps) {
  const current = photos[clampIndex(index, photos.length)];
  const touchStartX = useRef(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [originalLoadedId, setOriginalLoadedId] = useState<string | null>(null);
  const [originalFailedId, setOriginalFailedId] = useState<string | null>(null);
  const [thumbFailedId, setThumbFailedId] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'rename' | 'confirm'>('view');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const currentId = current?.id;

  // 写真が切り替わったら編集・確認状態を持ち越さない。
  useEffect(() => {
    setMode('view');
    setActionError(null);
  }, [currentId]);

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
      if (e.key === 'Escape') {
        if (busyRef.current) return;
        if (mode !== 'view') setMode('view');
        else onClose();
        return;
      }
      // 名前入力中・確認中・処理中は左右キーで写真を送らない。
      if (mode !== 'view' || busyRef.current) return;
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!current) return null;
  const name = photoName(current);
  const manageable = !!canManage?.(current) && !!onRename && !!onDelete;

  // 処理中の二重送信を防ぐ。
  const run = async (action: () => Promise<void>, onDone: () => void) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setActionError(null);
    try {
      await action();
      onDone();
    } catch (e) {
      setActionError(e instanceof Error && e.message ? e.message : '処理に失敗しました');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const startRename = () => {
    setDraft(name);
    setActionError(null);
    setMode('rename');
  };
  const submitRename = (e: React.FormEvent) => {
    e.preventDefault();
    void run(() => onRename!(current, draft), () => setMode('view'));
  };
  const confirmDelete = () => void run(() => onDelete!(current), () => setMode('view'));

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
      <div className="pmap-viewer-backdrop" onClick={() => !busy && mode === 'view' && onClose()} />
      <div className="pmap-viewer-dialog" role="dialog" aria-modal="true" aria-label="写真詳細">
        <button ref={closeRef} className="pmap-viewer-close" type="button" onClick={onClose} disabled={busy} aria-label="閉じる">×</button>
        <button className="pmap-viewer-nav pmap-viewer-prev" type="button" onClick={() => go(-1)} disabled={index <= 0 || busy} aria-label="前の写真">‹</button>
        <button className="pmap-viewer-nav pmap-viewer-next" type="button" onClick={() => go(1)} disabled={index >= photos.length - 1 || busy} aria-label="次の写真">›</button>
        <div className="pmap-viewer-head">
          {mode === 'rename' ? (
            <form className="pmap-viewer-rename" onSubmit={submitRename}>
              <input
                className="pmap-viewer-rename-input"
                aria-label="写真の名前"
                value={draft}
                maxLength={MAX_TITLE_LENGTH}
                disabled={busy}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
              />
              <button className="pmap-viewer-action" type="submit" disabled={busy}>{busy ? '保存中…' : '保存'}</button>
              <button className="pmap-viewer-action" type="button" disabled={busy} onClick={() => setMode('view')}>キャンセル</button>
            </form>
          ) : (
            <h2 className="pmap-viewer-name">{name}</h2>
          )}
          <p className="pmap-viewer-taken">
            {formatDate(current)}
            {current.uploaderName && ` ・ ${current.uploaderName}`}
          </p>
          <div className="pmap-viewer-meta">
            <p className="pmap-viewer-index">{index + 1} / {photos.length}</p>
            {manageable && mode === 'view' && (
              <div className="pmap-viewer-actions">
                <button className="pmap-viewer-action" type="button" onClick={startRename}>名前を変更</button>
                <button className="pmap-viewer-action pmap-viewer-action-danger" type="button" onClick={() => { setActionError(null); setMode('confirm'); }}>削除</button>
              </div>
            )}
          </div>
          {actionError && mode !== 'confirm' && <p className="pmap-viewer-error" role="alert">{actionError}</p>}
        </div>
        <div className="pmap-viewer-stage">
          {showOriginal && (
            <img
              key={`original-${current.id}`}
              className="pmap-viewer-image"
              style={originalReady ? undefined : { display: 'none' }}
              src={originalSrc}
              alt={name}
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
              alt={name}
              onError={() => setThumbFailedId(current.id)}
              {...swipe}
            />
          )}
          {showOriginal && !originalReady && <p className="pmap-viewer-loading" role="status">原本を読み込み中…</p>}
          {!showOriginal && !showThumb && <p className="pmap-viewer-missing">この写真の画像を表示できません</p>}
        </div>
        {mode === 'confirm' && (
          <div className="pmap-confirm-backdrop">
            <div className="pmap-confirm" role="alertdialog" aria-modal="true" aria-labelledby="pmap-confirm-title" aria-describedby="pmap-confirm-body">
              <h3 id="pmap-confirm-title">この写真を削除しますか？</h3>
              <p id="pmap-confirm-body">
                「<b className="pmap-confirm-name">{name}</b>」を削除します。Google Driveの原本とサムネイル、地図上のマーカー、一覧の記録がすべて消え、元に戻せません。
              </p>
              {actionError && <p className="pmap-viewer-error" role="alert">{actionError}</p>}
              <div className="pmap-confirm-buttons">
                <button className="pmap-viewer-action" type="button" onClick={() => setMode('view')} disabled={busy} autoFocus>キャンセル</button>
                <button className="pmap-viewer-action pmap-viewer-action-danger" type="button" onClick={confirmDelete} disabled={busy}>{busy ? '削除中…' : '削除する'}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
