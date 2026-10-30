import { useCallback, useEffect, useMemo, useState } from 'react';
import { APIProvider, Map, useMap } from '@vis.gl/react-google-maps';
import { ArrowDownUp, Camera, ImagePlus, LogOut, MapPin, Search } from 'lucide-react';
import { Link, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { useAuth } from './auth';
import { API_BASE, usePhotos, useRegions, type Photo } from './data';
import { originalUrl, thumbnailUrl } from './lib/photoUrls';
import type { PhotoPoint } from './lib/photoGroups';
import { loadMapType, MAP_TYPE_IDS, saveMapType } from './lib/mapType';
import { uploadAvailability } from './lib/uploadAvailability';
import ClusterSheet from './photoMap/ClusterSheet';
import { PhotoLayer, type FocusRequest } from './photoMap/PhotoLayer';
import PhotoViewer from './photoMap/PhotoViewer';
import './photoMap/photoMap.css';
import type { LatLng } from './regionList';
import UploadDialog from './UploadDialog';

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

// 標準の地図タイプ切替を右上に出し、選択をlocalStorageに保存・復元する（中心・ズームには触れない）。
function MapTypeControl() {
  const map = useMap();
  useEffect(() => {
    if (!map) return;
    map.setMapTypeId(loadMapType());
    map.setOptions({
      mapTypeControl: true,
      mapTypeControlOptions: {
        position: google.maps.ControlPosition.TOP_RIGHT,
        style: google.maps.MapTypeControlStyle.HORIZONTAL_BAR,
        mapTypeIds: [...MAP_TYPE_IDS],
      },
    });
    const listener = map.addListener('maptypeid_changed', () => saveMapType(map.getMapTypeId()));
    return () => listener.remove();
  }, [map]);
  return null;
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
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const [viewer, setViewer] = useState<{ photos: PhotoPoint[]; index: number } | null>(null);
  const [sheet, setSheet] = useState<PhotoPoint[] | null>(null);
  const [keyword, setKeyword] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const { user, loading: authLoading, configured: authConfigured } = useAuth();
  // 閲覧はログイン不要。アップロードだけログイン必須（サーバーでもFirebaseトークンを検証する）。
  const upload = uploadAvailability({ user, authLoading, authConfigured, apiBase: API_BASE });
  const canUpload = upload.enabled;
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

  const visiblePhotos = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    return q
      ? photos.filter((p) => `${p.originalFilename} ${p.uploaderName}`.toLowerCase().includes(q))
      : photos;
  }, [photos, keyword]);

  // 地図と一覧は同じselectedIdを共有する（常に同期）。一覧・アップロードからの選択は地図をその写真へ移動する。
  const focusPhoto = useCallback((id: string) => {
    setSelectedId(id);
    setFocus((f) => ({ id, nonce: (f?.nonce ?? 0) + 1 }));
  }, []);

  const openViewer = useCallback((list: PhotoPoint[], index: number) => {
    setViewer({ photos: list, index });
    setSelectedId(list[index]?.id ?? null);
  }, []);

  const closeSheet = useCallback(() => {
    setSheet(null);
    // 元の実装と同じ。ビューアが開いていないときはシートを閉じると選択も解除する。
    setSelectedId((id) => (viewer ? id : null));
  }, [viewer]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (viewer) setViewer(null);
      else if (sheet) closeSheet();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewer, sheet, closeSheet]);

  // 地図側で選んだ写真が一覧の見える位置に来るようにする。
  useEffect(() => {
    if (selectedId) document.getElementById(`photo-item-${selectedId}`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

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
            <button
              className="upload-open"
              type="button"
              onClick={() => setUploadOpen(true)}
              disabled={!canUpload}
              title={upload.enabled ? '写真をアップロード' : upload.message}
            >
              <ImagePlus size={16} />
              <span>写真を追加</span>
            </button>
            {!upload.enabled && <p className="upload-hint" role="status">{upload.message}</p>}
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
                  <li key={p.id} id={`photo-item-${p.id}`}>
                    <button
                      type="button"
                      className={`photo-item${p.id === selectedId ? ' selected' : ''}`}
                      aria-pressed={p.id === selectedId}
                      onClick={() => focusPhoto(p.id)}
                    >
                      {p.thumbnailDriveFileId && API_BASE ? (
                        <img
                          className="photo-thumb"
                          src={`${API_BASE}/photos/${encodeURIComponent(p.id)}/thumbnail`}
                          alt=""
                          loading="lazy"
                          decoding="async"
                        />
                      ) : (
                        <span className="photo-thumb photo-thumb-empty" aria-hidden="true"><Camera size={16} /></span>
                      )}
                      <span className="photo-text">
                        <span className="photo-name">{p.originalFilename}</span>
                        <span className="photo-meta">{formatCaptured(p)}</span>
                        <span className="photo-meta">
                          {p.uploaderName || '投稿者不明'}
                          {!p.hasGps && ' ・ 位置未設定'}
                        </span>
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
                  mapId={import.meta.env.VITE_GOOGLE_MAPS_MAP_ID || 'DEMO_MAP_ID'}
                  gestureHandling="greedy"
                  disableDefaultUI
                  zoomControl
                  fullscreenControl
                  className="google-map"
                >
                  <MapTypeControl />
                  <RegionViewport center={region.defaultCenter} zoom={region.defaultZoom} />
                  <PhotoLayer
                    photos={visiblePhotos}
                    selectedId={selectedId}
                    focus={focus}
                    fitKey={region.slug}
                    thumbnailUrl={thumbnailUrl}
                    onSelect={setSelectedId}
                    onOpenViewer={openViewer}
                    onOpenSheet={setSheet}
                  />
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
      {uploadOpen && canUpload && (
        <UploadDialog
          regionSlug={region.slug}
          regionName={region.name}
          onClose={() => setUploadOpen(false)}
          // アップロードされた写真はFirestoreの購読で一覧・地図に現れる。選択状態にして地図をそこへ寄せる。
          onUploaded={focusPhoto}
        />
      )}
      {/* ビューアを閉じるとシートに戻れるよう、ビューアが開いていてもシートは下に残す。 */}
      {sheet && <ClusterSheet photos={sheet} thumbnailUrl={thumbnailUrl} onPick={(i) => openViewer(sheet, i)} onClose={closeSheet} />}
      {viewer && (
        <PhotoViewer
          photos={viewer.photos}
          index={viewer.index}
          imageUrl={thumbnailUrl}
          originalUrl={originalUrl}
          formatDate={formatCaptured}
          onIndexChange={(index) => openViewer(viewer.photos, index)}
          onClose={() => setViewer(null)}
        />
      )}
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