import { APIProvider, Map } from '@vis.gl/react-google-maps';
import { ArrowDownUp, Camera, MapPin, Search } from 'lucide-react';
import { Link, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';

const regions = [
  { slug: 'yurihonjo', name: '由利本荘', count: '01' },
  { slug: 'akita', name: '秋田', count: '02' },
  { slug: 'noshiro', name: '能代', count: '03' },
] as const;

const regionCoordinates: Record<string, { lat: number; lng: number }> = {
  yurihonjo: { lat: 39.3853, lng: 140.0488 },
  akita: { lat: 39.7186, lng: 140.1024 },
  noshiro: { lat: 40.2122, lng: 140.0278 },
};

function Photomap() {
  const { slug = 'yurihonjo' } = useParams();
  const location = useLocation();
  const region = regions.find((item) => item.slug === slug);
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

  if (!region) return <Navigate to="/yurihonjo" replace />;

  return (
    <main className="app-shell">
      <aside className="rail" aria-label="メインナビゲーション">
        <Link className="brand-mark" to="/yurihonjo" aria-label="Photomap ホーム">
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
            <button className="profile-button" type="button" title="Phase 2でログインを追加">
              <span className="profile-dot" />
              <span>ゲスト</span>
            </button>
          </div>
        </header>

        <div className="regionbar">
          <div className="region-intro">
            <span className="eyebrow">地域マップ</span>
            <h1>{region.name}</h1>
          </div>
          <nav className="region-tabs" aria-label="地域を選択">
            {regions.map((item) => (
              <Link
                key={item.slug}
                className={`region-tab${item.slug === slug ? ' selected' : ''}`}
                to={`/${item.slug}`}
                aria-current={item.slug === slug ? 'page' : undefined}
              >
                <span>{item.name}</span>
                <span className="tab-index">{item.count}</span>
              </Link>
            ))}
          </nav>
        </div>

        <div className="content-grid">
          <section className="photo-panel" aria-label={`${region.name}の写真一覧`}>
            <div className="panel-heading">
              <div>
                <span className="eyebrow">COLLECTION</span>
                <h2>写真一覧 <span className="photo-count">00</span></h2>
              </div>
              <button className="icon-button" type="button" aria-label="撮影日時順" title="撮影日時順">
                <ArrowDownUp size={17} />
              </button>
            </div>
            <label className="search-box">
              <Search size={16} aria-hidden="true" />
              <input aria-label="写真を検索" placeholder="場所・投稿者を検索" />
              <kbd>/</kbd>
            </label>
            <div className="empty-collection">
              <div className="empty-icon"><Camera size={22} strokeWidth={1.5} /></div>
              <p className="empty-title">まだ写真がありません</p>
              <p className="empty-copy">この地域に投稿された写真が<br />ここに表示されます。</p>
            </div>
            <div className="panel-footer">
              <span><i /> 地図と同期中</span>
              <span>0 PHOTOS</span>
            </div>
          </section>

          <section className="map-panel" aria-label={`${region.name}の地図`}>
            {apiKey ? (
              <APIProvider apiKey={apiKey}>
                <Map
                  key={slug}
                  defaultCenter={regionCoordinates[slug]}
                  defaultZoom={12}
                  mapId={import.meta.env.VITE_GOOGLE_MAPS_MAP_ID || undefined}
                  gestureHandling="greedy"
                  disableDefaultUI
                  zoomControl
                  fullscreenControl
                  className="google-map"
                />
              </APIProvider>
            ) : (
              <div className="map-key-state">
                <div className="map-crosshair"><MapPin size={24} strokeWidth={1.4} /></div>
                <span className="eyebrow">MAP PREVIEW</span>
                <p>地図を表示するには<br />Maps APIキーを設定してください</p>
                <code>VITE_GOOGLE_MAPS_API_KEY</code>
              </div>
            )}
            <div className="map-label"><span className="map-label-dot" />{region.name}<span>秋田県</span></div>
            <div className="map-coordinates">{regionCoordinates[slug].lat.toFixed(4)}°N&nbsp; {regionCoordinates[slug].lng.toFixed(4)}°E</div>
            <div className="map-attribution">PHOTOMAP <span>·</span> FIELDWORK SERIES</div>
          </section>
        </div>
        <footer className="statusbar">
          <span>PHOTO MAPPING FOR FIELDWORK</span>
          <span className="status-location">{location.pathname.replace(import.meta.env.BASE_URL, '/')}</span>
          <span>秋田県 <b>·</b> JAPAN</span>
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
      <Route path="*" element={<Navigate to="/yurihonjo" replace />} />
    </Routes>
  );
}