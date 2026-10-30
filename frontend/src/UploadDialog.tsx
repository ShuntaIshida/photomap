import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, ImagePlus, Loader2, X, XCircle } from 'lucide-react';
import { useAuth } from './auth';
import { API_BASE } from './data';
import { inspectPhoto, type ImageKind } from './lib/photoFile';
import { describeUploadError, UploadError, uploadPhoto } from './lib/uploadApi';
import { runPool, UPLOAD_CONCURRENCY } from './lib/uploadQueue';

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
  ready: 'アップロード待ち',
  rejected: 'アップロードできません',
  uploading: 'アップロード中…',
  done: '完了',
  failed: '失敗',
};

// これらのエラーは以降のファイルでも続くため、残りの送信を止める（待機中の写真はそのまま残り、再開できる）。
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
  const [confirmClose, setConfirmClose] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const keyRef = useRef(0);
  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;
  const runningRef = useRef(false);

  const patch = useCallback((key: number, change: Partial<Item>) => {
    setItems((list) => list.map((it) => (it.key === key ? { ...it, ...change } : it)));
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  // アップロード中にタブを閉じる・移動すると中断されるため、ブラウザの確認を出す。
  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [running]);

  // 閉じる操作。アップロード中は即座に閉じず、中止してよいか確認する（Esc・×・背景クリック共通）。
  const requestClose = useCallback(() => {
    if (runningRef.current) {
      setConfirmClose(true);
      return;
    }
    onClose();
  }, [onClose]);

  const abortAndClose = () => {
    abortRef.current?.abort();
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (confirmClose) setConfirmClose(false);
      else requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestClose, confirmClose]);

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setNotice(null);
    // 枚数は制限せず、選ばれた全ファイルを対象にする。
    const added: Item[] = [...files].map((file) => ({ key: ++keyRef.current, file, status: 'checking' }));
    setItems((list) => [...list, ...added]);
    // メモリ使用を抑えるため1枚ずつ検査する。
    for (const it of added) {
      const result = await inspectPhoto(it.file);
      if (result.ok) patch(it.key, { status: 'ready', kind: result.kind, message: result.serverCheck ? 'アップロード待ち（位置情報はサーバーで確認します）' : undefined });
      else patch(it.key, { status: 'rejected', message: result.reason });
    }
  };

  const uploadOne = async (it: Item, signal: AbortSignal): Promise<'continue' | 'stop'> => {
    patch(it.key, { status: 'uploading', message: undefined });
    try {
      // 長い一括アップロードでも期限切れにならないよう、毎回最新のIDトークンを取得する。
      const token = await user!.getIdToken();
      const { photoId } = await uploadPhoto({ apiBase: API_BASE, slug: regionSlug, token, file: it.file, filename: it.file.name, signal });
      patch(it.key, { status: 'done' });
      onUploaded(photoId);
      return 'continue';
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') {
        patch(it.key, { status: 'ready', message: '中止しました' });
        return 'stop';
      }
      patch(it.key, { status: 'failed', message: describeUploadError(e) });
      if (e instanceof UploadError && STOP_CODES.has(e.code)) {
        // 続けても同じ原因で失敗するため、全体を止める。待機中の写真は残る。
        setNotice(`${describeUploadError(e)}。残りの写真は待機のままです。解決後に「続ける」を押してください。`);
        return 'stop';
      }
      return 'continue';
    }
  };

  // 指定した写真だけを同時2枚で順に送る。1枚の失敗は他の写真に影響しない。
  const run = async (targets: Item[]) => {
    if (!user || runningRef.current || targets.length === 0) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    runningRef.current = true;
    setRunning(true);
    setNotice(null);
    await runPool(targets, UPLOAD_CONCURRENCY, (it) => uploadOne(it, ctrl.signal), ctrl.signal);
    runningRef.current = false;
    setRunning(false);
    setConfirmClose(false);
  };

  const start = () => void run(items.filter((it) => it.status === 'ready'));

  // 失敗した写真だけをもう一度送る。
  const retryFailed = () => {
    const targets = items.filter((it) => it.status === 'failed');
    setItems((list) => list.map((it) => (it.status === 'failed' ? { ...it, status: 'ready', message: undefined } : it)));
    void run(targets);
  };

  const count = (s: Status) => items.filter((i) => i.status === s).length;
  const readyCount = count('ready');
  const doneCount = count('done');
  const failedCount = count('failed');
  const uploadingCount = count('uploading');
  const rejectedCount = count('rejected');
  const checkingCount = count('checking');
  // アップロード対象（確認で弾かれた写真は含めない）。
  const targetCount = items.length - rejectedCount - checkingCount;
  const progress = targetCount > 0 ? Math.round(((doneCount + failedCount) / targetCount) * 100) : 0;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="upload-title">
        <div className="modal-header">
          <div>
            <span className="eyebrow">UPLOAD</span>
            <h2 id="upload-title">写真を追加（{regionName}）</h2>
          </div>
          <button className="icon-button" type="button" onClick={requestClose} aria-label="閉じる">
            <X size={17} />
          </button>
        </div>

        {!API_BASE && <p className="upload-warning">アップロード先APIが設定されていません（VITE_API_BASE_URL）。</p>}

        <p className="upload-help">
          GPS位置情報つきのJPEG・HEIC写真（1枚20MBまで）を、枚数の制限なく選べます。サーバーへは同時{UPLOAD_CONCURRENCY}枚ずつ順に送ります。GPS情報のない写真は、今回はアップロードできません。
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
          <div className="upload-progress" role="status" aria-live="polite">
            <div className="upload-progress-line">
              <strong>{doneCount + failedCount} / {targetCount}枚完了</strong>
              <span>
                成功 {doneCount}・失敗 {failedCount}
                {readyCount + uploadingCount > 0 && `・待機 ${readyCount + uploadingCount}`}
                {rejectedCount > 0 && `・対象外 ${rejectedCount}`}
                {checkingCount > 0 && `・確認中 ${checkingCount}`}
              </span>
            </div>
            <div className="upload-bar" aria-hidden="true"><div className="upload-bar-fill" style={{ width: `${progress}%` }} /></div>
          </div>
        )}

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

        {confirmClose && (
          <div className="upload-confirm" role="alertdialog" aria-labelledby="upload-confirm-title">
            <p id="upload-confirm-title">アップロード中です。閉じると、送信中の写真と待機中の写真のアップロードを中止します（完了した写真は残ります）。</p>
            <div className="upload-confirm-buttons">
              <button className="primary-button" type="button" onClick={() => setConfirmClose(false)} autoFocus>続ける</button>
              <button className="upload-secondary" type="button" onClick={abortAndClose}>中止して閉じる</button>
            </div>
          </div>
        )}

        <div className="modal-footer">
          <span className="upload-summary">{doneCount > 0 ? `${doneCount}枚をアップロードしました` : ''}</span>
          <span className="upload-actions">
            {failedCount > 0 && (
              <button className="upload-secondary" type="button" onClick={retryFailed} disabled={!user || running}>失敗した{failedCount}枚を再試行</button>
            )}
            <button className="primary-button" type="button" onClick={start} disabled={!user || running || readyCount === 0 || checkingCount > 0}>
              {running ? 'アップロード中…' : doneCount + failedCount > 0 ? `続ける（${readyCount}枚）` : `アップロード（${readyCount}枚）`}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
