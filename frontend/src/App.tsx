import { useCallback, useEffect, useMemo, useState } from 'react';
import { APIProvider, Map, useMap } from '@vis.gl/react-google-maps';
import { ArrowDownUp, Camera, ImagePlus, LogOut, MapPin, Search } from 'lucide-react';
import { Link, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { useAuth } from './auth';
import { API_BASE, photoName, usePhotos, useRegions, type Photo } from './data';
import { originalUrl, thumbnailUrl } from './lib/photoUrls';
import type { PhotoPoint } from './lib/photoGroups';
import { describePhotoError, deletePhoto, PhotoApiError, renamePhoto } from './lib/photoApi';
import { loadMapType, MAP_TYPE_IDS, saveMapType } from './lib/mapType';
import { useIsAdmin } from './lib/useIsAdmin';
import { uploadAvailability } from './lib/uploadAvailability';
import ClusterSheet from './photoMap/ClusterSheet';
import { PhotoLayer, type FocusRequest } from './photoMap/PhotoLayer';
import PhotoViewer from './photoMap/PhotoViewer';
import './photoMap/photoMap.css';
import type { LatLng } from './regionList';
import AdminRegions from './AdminRegions';
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
  const { photos: fetchedPhotos, loading: photosLoading, error: photosError } = usePhotos(region?.id ?? null);
  // 名前変更・削除の直後はFirestoreの購読が追いつくまでの間も画面へ即時に反映する。
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [titleOverrides, setTitleOverrides] = useState<Readonly<Record<string, string>>>({});
  const photos = useMemo(
    () =>
      fetchedPhotos
        .filter((p) => !removedIds.has(p.id))
        .map((p) => (titleOverrides[p.id] !== undefined ? { ...p, title: titleOverrides[p.id]! } : p)),
    [fetchedPhotos, removedIds, titleOverrides],
  );
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
  const isAdmin = useIsAdmin(user, API_BASE);
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

  const visiblePhotos = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    return q
      ? photos.filter((p) => `${photoName(p)} ${p.originalFilename} ${p.uploaderName}`.toLowerCase().includes(q))
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
      // ビューアが開いている間のEscはビューア側が処理する（入力・確認の取り消しを優先するため）。
      if (!viewer && sheet) closeSheet();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewer, sheet, closeSheet]);

  // 地図側で選んだ写真が一覧の見える位置に来るようにする。
  useEffect(() => {
    if (selectedId) document.getElementById(`photo-item-${selectedId}`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  // ビューア・シートが持つ写真は、最新の一覧（タイトル更新・削除反映後）に合わせて表示する。
  // react-google-mapsのMapをimportしているため、組み込みのMapではなく普通のオブジェクトを使う。
  const photoById: Record<string, Photo> = Object.fromEntries(photos.map((p) => [p.id, p]));
  const fresh = <T extends Photo>(list: readonly T[]): T[] =>
    list.flatMap((p) => {
      const latest = photoById[p.id];
      return latest ? [{ ...p, title: latest.title }] : [];
    });
  const viewerPhotos = viewer ? fresh(viewer.photos) : [];
  const sheetPhotos = sheet ? fresh(sheet) : null;
  const viewerEmpty = viewer !== null && viewerPhotos.length === 0;
  useEffect(() => {
    if (viewerEmpty) setViewer(null);
  }, [viewerEmpty]);

  const canManage = (photo: Photo) => !!user && (isAdmin || (photo.uploaderUid !== '' && photo.uploaderUid === user.uid));

  const manageError = (e: unknown, fallback: string) => new Error(describePhotoError(e, fallback));
  const authToken = async () => {
    if (!user) throw new PhotoApiError('unauthenticated', 401);
    return user.getIdToken();
  };

  const renameSelected = async (photo: Photo, title: string) => {
    try {
      const saved = await renamePhoto({ apiBase: API_BASE, photoId: photo.id, token: await authToken() }, title);
      setTitleOverrides((m) => ({ ...m, [photo.id]: saved }));
    } catch (e) {
      throw manageError(e, '名前を変更できませんでした');
    }
  };

  const deleteSelected = async (photo: Photo) => {
    try {
      await deletePhoto({ apiBase: API_BASE, photoId: photo.id, token: await authToken() });
    } catch (e) {
      // 既に消えている写真は、画面からも取り除いて整合させる。
      if (e instanceof PhotoApiError && e.code === 'photo_not_found') setRemovedIds((s) => new Set(s).add(photo.id));
      throw manageError(e, '写真を削除できませんでした');
    }
    setRemovedIds((s) => new Set(s).add(photo.id));
    setSelectedId((id) => (id === photo.id ? null : id));
  };

  if (!region) return <RegionMissing loading={regionsLoading} />;
  const countLabel = String(photos.length).padStart(2, '0');

  return (
    <main className="app-shell">
      <section className="workspace">
        <header className="topbar">
          <div className="wordmark"><span>PHOTO</span>MAP</div>
          <div className="topbar-right">
            {isAdmin && <Link className="admin-link" to="/admin/regions">地域設定</Link>}
            <UserMenu />
          </div>
        </header>

        {!region.configured && (
          <p className="region-unconfigured" role="status">
            この地域の表示設定（地域名・初期位置）は未設定です。
            {isAdmin ? <Link to="/admin/regions">地域設定で入力してください</Link> : '管理者による設定をお待ちください。'}
          </p>
        )}

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
                        <span className="photo-name">{photoName(p)}</span>
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
          <span className="status-location">{location.pathname.replace(import.meta.env.BASE_URL, '/')}</span>
          <span className="status-copyright">© Shunta Ishida</span>
          <span className="status-region">{region.prefecture ? <>{region.prefecture} <b>·</b> JAPAN</> : 'JAPAN'}</span>
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
      {sheetPhotos && sheetPhotos.length > 0 && <ClusterSheet photos={sheetPhotos} thumbnailUrl={thumbnailUrl} onPick={(i) => openViewer(sheetPhotos, i)} onClose={closeSheet} />}
      {viewer && viewerPhotos.length > 0 && (
        <PhotoViewer
          photos={viewerPhotos}
          index={Math.min(viewer.index, viewerPhotos.length - 1)}
          canManage={canManage}
          onRename={renameSelected}
          onDelete={deleteSelected}
          imageUrl={thumbnailUrl}
          originalUrl={originalUrl}
          formatDate={formatCaptured}
          onIndexChange={(index) => openViewer(viewerPhotos, index)}
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
      <Route path="/admin/regions" element={<AdminRegions />} />
      <Route path="/:slug" element={<Photomap />} />
      <Route path="*" element={<RegionMissing />} />
    </Routes>
  );
}