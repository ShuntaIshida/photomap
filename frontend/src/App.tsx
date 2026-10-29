import { useEffect, useMemo, useState } from 'react';
import { APIProvider, Map, Marker, useMap } from '@vis.gl/react-google-maps';
import { ArrowDownUp, Camera, LogOut, MapPin, Search } from 'lucide-react';
import { Link, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { useAuth } from './auth';
import { usePhotos, useRegions, type Photo } from './data';
import type { LatLng } from './regionList';

const dateFormat = new Intl.DateTimeFormat('ja-JP', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Tokyo',
});

function formatCaptured(photo: Photo) {
  const date = photo.capturedAt ?? photo.uploadedAt;
  if (!date) return '日時不明';
  const text = dateFormat.format(date);
  if (!photo.capturedAt) return `投稿 ${text}`;
  return photo.capturedAtTimeZoneKnown ? text : `${text}（時刻帯不明）`;
}

function UserMenu() {
  const { user, loading, configured, error, signIn, signOut } = useAuth();

  if (!configured) {
    return (
      <button className="profile-button" type="button" disabled title="Firebaseの環境変数が未設定です">
        <span className="profile-dot" />
        <span>ゲスト</span>
      </button>
    );
  }
  if (loading) return <span className="profile-button">確認中…</span>;
  if (!user) {
    return (
      <div className="auth-group">
        {error && <span className="auth-error" role="alert">{error}</span>}
        <button className="profile-button" type="button" onClick={() => void signIn()} title="Googleでログイン">
          <span className="profile-dot" />
          <span>ゲスト</span>
          <span className="login-label">ログイン</span>
        </button>
      </div>
    );
  }
  const name = user.displayName || user.email || 'ユーザー';
  return (
    <div className="auth-group">
      <span className="profile-button" title={user.email ?? undefined}>
        {user.photoURL ? (
          <img className="profile-avatar" src={user.photoURL} alt="" referrerPolicy="no-referrer" />
        ) : (
          <span className="profile-dot" />
        )}
        <span className="profile-name">{name}</span>
      </span>
      <button className="icon-button" type="button" onClick={() => void signOut()} aria-label="ログアウト" title="ログアウト">
        <LogOut size={16} />
      </button>
    </div>
  );
}

// 地域切替時に地図を作り直さず表示範囲だけを移す（再生成するとMaps内部で未処理例外が出る）。
function RegionViewport({ center, zoom }: { center: LatLng; zoom: number }) {
  const map = useMap();
  useEffect(() => {
    map?.setCenter({ lat: center.lat, lng: center.lng });
    map?.setZoom(zoom);
  }, [map, center.lat, center.lng, zoom]);
  return null;
}

function PhotoMarkers({ photos, selectedId, onSelect }: { photos: Photo[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const map = useMap();
  const selected = photos.find((p) => p.id === selectedId);

  useEffect(() => {
    if (map && selected?.latitude != null && selected.longitude != null) {
      map.panTo({ lat: selected.latitude, lng: selected.longitude });
    }
  }, [map, selected]);

  return (
    <>
      {photos.map((p) =>
        p.latitude != null && p.longitude != null ? (
          <Marker
            key={p.id}
            position={{ lat: p.latitude, lng: p.longitude }}
            title={p.originalFilename}
            zIndex={p.id === selectedId ? 10 : 1}
            onClick={() => onSelect(p.id)}
            icon={{
              path: google.maps.SymbolPath.CIRCLE,
              scale: p.id === selectedId ? 11 : 7,
              fillColor: p.id === selectedId ? '#e6a23c' : '#27725d',
              fillOpacity: 1,
              strokeColor: '#ffffff',
              strokeWeight: 2,
            }}
          />
        ) : null,
      )}
    </>
  );
}

function RegionMissing({ loading = false }: { loading?: boolean }) {
  return (
    <main className="region-missing">
      <h1>{loading ? '読み込み中…' : '地域が見つかりません'}</h1>
      {!loading && <p>URLをご確認ください。</p>}
    </main>
  );
}

function Photomap() {
  const { slug = '' } = useParams();
  const location = useLocation();
  // Driveから取得した一覧はURLの有効性判定にのみ使い、画面には表示しない。
  const { regions, loading: regionsLoading } = useRegions();
  const region = regions.find((item) => item.slug === slug);
  const { photos, loading: photosLoading, error: photosError } = usePhotos(region?.id ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

  const visiblePhotos = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    return q
      ? photos.filter((p) => `${p.originalFilename} ${p.uploaderName}`.toLowerCase().includes(q))
      : photos;
  }, [photos, keyword]);

  if (!region) return <RegionMissing loading={regionsLoading} />;
  const countLabel = String(photos.length).padStart(2, '0');

  return (
    <main className="app-shell">
      <aside className="rail" aria-label="メインナビゲーション">
        <Link className="brand-mark" to={`/${region.slug}`} aria-label={`Photomap ${region.name}`}>
          <MapPin size={21} strokeWidth={2.2} />
        </Link>
        <div className="rail-rule" />
        <button className="rail-button is-active" aria-label="地図" title="地図">
          <MapPin size={19} />
        </button>
        <button className="rail-button" aria-label="写真" title="写真">
          <Camera size={19} />
        </button>
        <div className="rail-spacer" />
        <span className="rail-version">FIELD<br />NOTES</span>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="wordmark"><span>PHOTO</span>MAP</div>
          <div className="topbar-right">
            <span className="edition-label">FIELDWORK ATLAS <span>2026</span></span>
            <UserMenu />
          </div>
        </header>

        <div className="regionbar">
          <div className="region-intro">
            <span className="eyebrow">地域マップ</span>
            <h1>{region.name}</h1>
          </div>
        </div>

        <div className="content-grid">
          <section className="photo-panel" aria-label={`${region.name}の写真一覧`}>
            <div className="panel-heading">
              <div>
                <span className="eyebrow">COLLECTION</span>
                <h2>写真一覧 <span className="photo-count">{countLabel}</span></h2>
              </div>
              <button className="icon-button" type="button" aria-label="撮影日時順" title="撮影日時順">
                <ArrowDownUp size={17} />
              </button>
            </div>
            <label className="search-box">
              <Search size={16} aria-hidden="true" />
              <input
                aria-label="写真を検索"
                placeholder="ファイル名・投稿者を検索"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
              />
              <kbd>/</kbd>
            </label>
            {visiblePhotos.length > 0 ? (
              <ul className="photo-list">
                {visiblePhotos.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className={`photo-item${p.id === selectedId ? ' selected' : ''}`}
                      aria-pressed={p.id === selectedId}
                      onClick={() => setSelectedId(p.id)}
                    >
                      <span className="photo-name">{p.originalFilename}</span>
                      <span className="photo-meta">{formatCaptured(p)}</span>
                      <span className="photo-meta">
                        {p.uploaderName || '投稿者不明'}
                        {!p.hasGps && ' ・ 位置未設定'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="empty-collection">
                <div className="empty-icon"><Camera size={22} strokeWidth={1.5} /></div>
                <p className="empty-title">
                  {photosError ? '写真を読み込めませんでした' : photosLoading ? '読み込み中…' : photos.length ? '該当する写真がありません' : 'まだ写真がありません'}
                </p>
                <p className="empty-copy">この地域に投稿された写真が<br />ここに表示されます。</p>
              </div>
            )}
            <div className="panel-footer">
              <span><i /> 地図と同期中</span>
              <span>{photos.length} PHOTOS</span>
            </div>
          </section>

          <section className="map-panel" aria-label={`${region.name}の地図`}>
            {apiKey ? (
              <APIProvider apiKey={apiKey}>
                <Map
                  defaultCenter={region.defaultCenter}
                  defaultZoom={region.defaultZoom}
                  mapId={import.meta.env.VITE_GOOGLE_MAPS_MAP_ID || undefined}
                  gestureHandling="greedy"
                  disableDefaultUI
                  zoomControl
                  fullscreenControl
                  className="google-map"
                >
                  <RegionViewport center={region.defaultCenter} zoom={region.defaultZoom} />
                  <PhotoMarkers photos={visiblePhotos} selectedId={selectedId} onSelect={setSelectedId} />
                </Map>
              </APIProvider>
            ) : (
              <div className="map-key-state">
                <div className="map-crosshair"><MapPin size={24} strokeWidth={1.4} /></div>
                <span className="eyebrow">MAP PREVIEW</span>
                <p>地図を表示するには<br />Maps APIキーを設定してください</p>
                <code>VITE_GOOGLE_MAPS_API_KEY</code>
              </div>
            )}
            <div className="map-label"><span className="map-label-dot" />{region.name}{region.prefecture && <span>{region.prefecture}</span>}</div>
            <div className="map-coordinates">{region.defaultCenter.lat.toFixed(4)}°N&nbsp; {region.defaultCenter.lng.toFixed(4)}°E</div>
            <div className="map-attribution">PHOTOMAP <span>·</span> FIELDWORK SERIES</div>
          </section>
        </div>
        <footer className="statusbar">
          <span>PHOTO MAPPING FOR FIELDWORK</span>
          <span className="status-location">{location.pathname.replace(import.meta.env.BASE_URL, '/')}</span>
          <span>{region.prefecture ? <>{region.prefecture} <b>·</b> JAPAN</> : 'JAPAN'}</span>
        </footer>
      </section>
    </main>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/yurihonjo" replace />} />
      <Route path="/:slug" element={<Photomap />} />
      <Route path="*" element={<RegionMissing />} />
    </Routes>
  );
}