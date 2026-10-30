import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, ImagePlus, Loader2, X, XCircle } from 'lucide-react';
import { useAuth } from './auth';
import { API_BASE } from './data';
import { inspectPhoto, MAX_FILES_PER_BATCH, type ImageKind } from './lib/photoFile';
import { describeUploadError, UploadError, uploadPhoto } from './lib/uploadApi';

type Status = 'checking' | 'ready' | 'rejected' | 'uploading' | 'done' | 'failed';

interface Item {
  key: number;
  file: File;
  status: Status;
  message?: string;
  kind?: ImageKind;
}

const STATUS_LABEL: Record<Status, string> = {
  checking: '確認中…',
  ready: 'アップロード可能',
  rejected: 'アップロードできません',
  uploading: 'アップロード中…',
  done: '完了',
  failed: '失敗',
};

// これらのエラーは以降のファイルでも続くため、残りの送信を止める。
const STOP_CODES = new Set(['unauthenticated', 'rate_limited', 'drive_not_authorized', 'drive_authorization_invalid', 'drive_scope_insufficient', 'region_not_found']);

interface Props {
  regionSlug: string;
  regionName: string;
  onClose: () => void;
  onUploaded: (photoId: string) => void;
}

export default function UploadDialog({ regionSlug, regionName, onClose, onUploaded }: Props) {
  const { user } = useAuth();
  const [items, setItems] = useState<Item[]>([]);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const keyRef = useRef(0);

  const patch = useCallback((key: number, change: Partial<Item>) => {
    setItems((list) => list.map((it) => (it.key === key ? { ...it, ...change } : it)));
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setNotice(null);
    const picked = [...files].slice(0, MAX_FILES_PER_BATCH);
    if (files.length > MAX_FILES_PER_BATCH) setNotice(`一度に選べるのは${MAX_FILES_PER_BATCH}枚までです。先頭の${MAX_FILES_PER_BATCH}枚を追加しました。`);
    const added: Item[] = picked.map((file) => ({ key: ++keyRef.current, file, status: 'checking' }));
    setItems((list) => [...list, ...added]);
    // メモリ使用を抑えるため1枚ずつ検査する。
    for (const it of added) {
      const result = await inspectPhoto(it.file);
      if (result.ok) patch(it.key, { status: 'ready', kind: result.kind, message: result.serverCheck ? 'アップロード可能（位置情報はサーバーで確認します）' : undefined });
      else patch(it.key, { status: 'rejected', message: result.reason });
    }
  };

  const start = async () => {
    if (!user || running) return;
    const targets = items.filter((it) => it.status === 'ready');
    if (!targets.length) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setRunning(true);
    setNotice(null);

    for (const it of targets) {
      if (ctrl.signal.aborted) break;
      patch(it.key, { status: 'uploading', message: undefined });
      try {
        // 原本は無加工のまま送る。サムネイルはサーバーが生成する。
        // 長いバッチでも期限切れにならないよう、毎回最新のIDトークンを取得する。
        const token = await user.getIdToken();
        const { photoId } = await uploadPhoto({
          apiBase: API_BASE,
          slug: regionSlug,
          token,
          file: it.file,
          filename: it.file.name,
          signal: ctrl.signal,
        });
        patch(it.key, { status: 'done' });
        onUploaded(photoId);
      } catch (e) {
        if ((e as { name?: string }).name === 'AbortError') break;
        patch(it.key, { status: 'failed', message: describeUploadError(e) });
        if (e instanceof UploadError && STOP_CODES.has(e.code)) {
          setNotice('エラーのため、残りのアップロードを中止しました。');
          break;
        }
      }
    }
    setRunning(false);
  };

  const close = () => {
    abortRef.current?.abort();
    onClose();
  };

  const readyCount = items.filter((i) => i.status === 'ready').length;
  const doneCount = items.filter((i) => i.status === 'done').length;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="upload-title">
        <div className="modal-header">
          <div>
            <span className="eyebrow">UPLOAD</span>
            <h2 id="upload-title">写真を追加（{regionName}）</h2>
          </div>
          <button className="icon-button" type="button" onClick={close} aria-label="閉じる">
            <X size={17} />
          </button>
        </div>

        {!API_BASE && <p className="upload-warning">アップロード先APIが設定されていません（VITE_API_BASE_URL）。</p>}

        <p className="upload-help">
          GPS位置情報つきのJPEG・HEIC写真（1枚20MBまで）を選べます。GPS情報のない写真は、今回はアップロードできません。
        </p>

        <label className={`upload-pick${!API_BASE || running ? ' is-disabled' : ''}`}>
          <ImagePlus size={18} />
          <span>写真を選択（複数可）</span>
          <input
            type="file"
            multiple
            accept="image/jpeg,image/heic,image/heif,.jpg,.jpeg,.heic,.heif"
            disabled={!API_BASE || running}
            onChange={(e) => {
              void addFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </label>

        {items.length > 0 && (
          <ul className="upload-list">
            {items.map((it) => (
              <li key={it.key} className={`upload-item is-${it.status}`}>
                <span className="upload-status-icon" aria-hidden="true">
                  {it.status === 'done' ? <CheckCircle2 size={16} /> : it.status === 'rejected' || it.status === 'failed' ? <XCircle size={16} /> : it.status === 'uploading' || it.status === 'checking' ? <Loader2 size={16} className="spin" /> : null}
                </span>
                <span className="upload-item-body">
                  <span className="upload-item-name">{it.file.name}</span>
                  <span className="upload-item-note">{it.message ?? STATUS_LABEL[it.status]}</span>
                </span>
              </li>
            ))}
          </ul>
        )}

        {notice && <p className="upload-warning" role="status">{notice}</p>}

        <div className="modal-footer">
          <span className="upload-summary">{doneCount > 0 ? `${doneCount}枚をアップロードしました` : ''}</span>
          <button className="primary-button" type="button" onClick={() => void start()} disabled={!user || running || readyCount === 0}>
            {running ? 'アップロード中…' : `アップロード（${readyCount}枚）`}
          </button>
        </div>
      </div>
    </div>
  );
}
