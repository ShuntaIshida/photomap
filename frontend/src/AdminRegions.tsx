import { useCallback, useEffect, useRef, useState } from 'react';
import { APIProvider, Map } from '@vis.gl/react-google-maps';
import { Link } from 'react-router-dom';
import { useAuth } from './auth';
import { API_BASE } from './data';
import type { LatLng } from './regionList';

export interface AdminRegion {
  slug: string;
  driveFolderId: string;
  configured: boolean;
  displayName: string | null;
  center: LatLng | null;
  zoom: number | null;
}

// 未設定の地域を編集するときの開始位置（日本全体）。
const START_VIEW = { center: { lat: 36.2, lng: 138.25 }, zoom: 5 };

const MESSAGES: Record<string, string> = {
  unauthenticated: 'ログインの有効期限が切れました。ログインし直してください',
  forbidden: '地域設定を変更できるのは管理者だけです',
  region_not_found: 'この地域はGoogle Driveに見つかりません',
  invalid_region_metadata: '入力内容が正しくありません（表示名は1〜50文字、ズームは1〜21）',
  drive_not_authorized: 'Google Driveが未認可です',
  drive_authorization_invalid: 'Google Driveの認可が切れています',
  drive_unavailable: 'Google Driveの取得に失敗しました。時間をおいてお試しください',
  network: 'ネットワークに接続できませんでした',
};

class AdminApiError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

async function adminFetch<T>(path: string, token: string, init?: { method: 'PUT'; body: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: init?.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(init ? { 'Content-Type': 'application/json' } : {}) },
      body: init ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new AdminApiError('network', 0);
  }
  if (!res.ok) {
    let code = 'unknown';
    try {
      const body = (await res.json()) as { error?: { code?: unknown } };
      if (typeof body.error?.code === 'string') code = body.error.code;
    } catch {
      // 本文がJSONでなければ未知のエラー。
    }
    throw new AdminApiError(code, res.status);
  }
  return (await res.json()) as T;
}

const describe = (e: unknown) => (e instanceof AdminApiError ? (MESSAGES[e.code] ?? '処理に失敗しました') : '処理に失敗しました');

function RegionEditor({ region, token, onSaved }: { region: AdminRegion; token: () => Promise<string>; onSaved: (r: AdminRegion) => void }) {
  const initial = region.configured && region.center && region.zoom !== null ? { center: region.center, zoom: region.zoom } : START_VIEW;
  const [displayName, setDisplayName] = useState(region.displayName ?? '');
  const [center, setCenter] = useState<LatLng>(initial.center);
  const [zoom, setZoom] = useState(initial.zoom);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const savingRef = useRef(false);
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setMessage(null);
    try {
      const { region: saved } = await adminFetch<{ region: AdminRegion }>(`/admin/regions/${encodeURIComponent(region.slug)}`, await token(), {
        method: 'PUT',
        body: { displayName, center, zoom },
      });
      onSaved(saved);
      setMessage({ ok: true, text: '保存しました。地域ページに反映されます' });
    } catch (err) {
      setMessage({ ok: false, text: describe(err) });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <form className="admin-editor" onSubmit={save}>
      <label className="admin-field">
        <span>slug（Driveのフォルダー名・URL）</span>
        <input value={region.slug} readOnly aria-readonly="true" />
      </label>
      <label className="admin-field">
        <span>表示名</span>
        <input value={displayName} maxLength={50} onChange={(e) => setDisplayName(e.target.value)} placeholder="例: 大垣" required />
      </label>
      <div className="admin-map">
        {apiKey ? (
          <APIProvider apiKey={apiKey}>
            <Map
              center={center}
              zoom={zoom}
              gestureHandling="greedy"
              mapTypeControl
              fullscreenControl={false}
              streetViewControl={false}
              onCameraChanged={(ev) => {
                setCenter({ lat: ev.detail.center.lat, lng: ev.detail.center.lng });
                setZoom(ev.detail.zoom);
              }}
              onClick={(ev) => ev.detail.latLng && setCenter({ lat: ev.detail.latLng.lat, lng: ev.detail.latLng.lng })}
              className="admin-map-canvas"
            />
            <div className="admin-crosshair" aria-hidden="true" />
          </APIProvider>
        ) : (
          <p className="admin-note">地図を表示するにはMaps APIキー（VITE_GOOGLE_MAPS_API_KEY）が必要です。</p>
        )}
      </div>
      <p className="admin-note">地図をクリック、またはドラッグして中央の＋を合わせ、ズームを調整してください。中央の位置と倍率が初期表示になります。</p>
      <dl className="admin-values">
        <div><dt>中心</dt><dd>{center.lat.toFixed(5)}, {center.lng.toFixed(5)}</dd></div>
        <div><dt>ズーム</dt><dd>{zoom.toFixed(2)}</dd></div>
      </dl>
      {message && <p className={message.ok ? 'admin-ok' : 'admin-error'} role={message.ok ? 'status' : 'alert'}>{message.text}</p>}
      <button className="primary-button" type="submit" disabled={saving || !displayName.trim()}>{saving ? '保存中…' : '保存'}</button>
    </form>
  );
}

export default function AdminRegions() {
  const { user, loading: authLoading, configured, signIn } = useAuth();
  const [regions, setRegions] = useState<AdminRegion[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);

  const token = useCallback(async () => {
    if (!user) throw new AdminApiError('unauthenticated', 401);
    return user.getIdToken();
  }, [user]);

  useEffect(() => {
    if (!user) return;
    let active = true;
    setError(null);
    setDenied(false);
    void (async () => {
      try {
        const body = await adminFetch<{ regions: AdminRegion[] }>('/admin/regions', await token());
        if (active) setRegions(body.regions);
      } catch (e) {
        if (!active) return;
        // 権限の判定はサーバーが行う。管理者以外は一覧そのものが返らない。
        if (e instanceof AdminApiError && e.status === 403) setDenied(true);
        else setError(describe(e));
      }
    })();
    return () => {
      active = false;
    };
  }, [user, token]);

  const current = regions?.find((r) => r.slug === selected) ?? null;

  return (
    <main className="admin-page">
      <header className="topbar">
        <div className="wordmark"><span>PHOTO</span>MAP</div>
        <Link className="admin-link" to="/">写真マップへ戻る</Link>
      </header>
      <section className="admin-body">
        <h1>地域設定</h1>
        {!configured ? (
          <p className="admin-note">Firebaseの設定が未完了のため利用できません。</p>
        ) : authLoading ? (
          <p className="admin-note">確認中…</p>
        ) : !user ? (
          <p className="admin-note">管理者としてログインしてください。<button className="primary-button" type="button" onClick={() => void signIn()}>ログイン</button></p>
        ) : denied ? (
          <p className="admin-error" role="alert">地域設定を変更できるのは管理者だけです。</p>
        ) : error ? (
          <p className="admin-error" role="alert">{error}</p>
        ) : !regions ? (
          <p className="admin-note">読み込み中…</p>
        ) : (
          <div className="admin-layout">
            <ul className="admin-list" aria-label="地域一覧">
              {regions.map((r) => (
                <li key={r.slug}>
                  <button type="button" className={`admin-region${r.slug === selected ? ' is-selected' : ''}`} onClick={() => setSelected(r.slug)} aria-pressed={r.slug === selected}>
                    <span className="admin-region-name">{r.displayName ?? r.slug}</span>
                    <span className="admin-region-slug">{r.slug}</span>
                    {!r.configured && <span className="admin-badge">未設定</span>}
                  </button>
                </li>
              ))}
              {regions.length === 0 && <li className="admin-note">Google Driveに地域フォルダーがありません。</li>}
            </ul>
            {current ? (
              <RegionEditor
                key={current.slug}
                region={current}
                token={token}
                onSaved={(saved) => setRegions((list) => list?.map((r) => (r.slug === saved.slug ? saved : r)) ?? list)}
              />
            ) : (
              <p className="admin-note">編集する地域を選んでください。</p>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
