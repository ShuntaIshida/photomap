import { useEffect, useRef } from 'react';
import { useMap, useMapsLibrary } from '@vis.gl/react-google-maps';
import { MarkerClusterer, SuperClusterAlgorithm } from '@googlemaps/markerclusterer';
import { photoName, type Photo } from '../data';
import {
  clusterMarkerSize,
  diffGroups,
  groupPhotosByLocation,
  groupSignature,
  pickRepresentativePhoto,
  SINGLE_MARKER_SIZE,
  sortPhotosDescByTakenAt,
  toPhotoPoint,
  type PhotoGroup,
  type PhotoPoint,
} from '../lib/photoGroups';
import { createMarkerElement, setElementSelected } from './markerElements';

export interface FocusRequest {
  id: string;
  /** 同じ写真を続けて指定しても再度移動できるようにする連番。 */
  nonce: number;
}

export interface PhotoLayerProps {
  /** 地図に出す写真（検索などで絞り込み済み。GPSのない写真は内部で除外する）。 */
  photos: readonly Photo[];
  selectedId: string | null;
  /** 一覧からの選択など、地図をその写真へ移動させたいときに指定する。 */
  focus: FocusRequest | null;
  /** 地域が変わったときだけ、写真全体が収まるよう表示範囲を合わせる。 */
  fitKey: string;
  thumbnailUrl: (photo: Photo) => string | null;
  onSelect: (id: string | null) => void;
  onOpenViewer: (photos: PhotoPoint[], index: number) => void;
  onOpenSheet: (photos: PhotoPoint[]) => void;
}

// nagareyama-photoのSuperClusterAlgorithm設定と同じ。
const CLUSTER_OPTIONS = { radius: 92, maxZoom: 18, minPoints: 2 } as const;
const MAX_FIT_ZOOM = 17;

interface MarkerEntry {
  marker: google.maps.marker.AdvancedMarkerElement;
  group: PhotoGroup;
  element: HTMLElement;
  ids: ReadonlySet<string>;
}

interface ClusterEntry {
  element: HTMLElement;
  ids: ReadonlySet<string>;
}

/**
 * 写真サムネイルのマーカーとクラスタを地図に描画する（nagareyama-photoのrenderData/createAdvancedPhotoMarkerの移植）。
 * Reactの再描画でマーカーを作り直さず、写真集合の差分だけをクラスタラーへ反映する。選択状態はクラスの付け外しだけで更新する。
 */
export function PhotoLayer(props: PhotoLayerProps) {
  const map = useMap();
  const markerLib = useMapsLibrary('marker');

  // 最新のpropsをコールバックから参照する（イベント登録を作り直さないため）。
  const latest = useRef(props);
  latest.current = props;

  const clusterer = useRef<MarkerClusterer | null>(null);
  const entries = useRef(new Map<string, MarkerEntry>());
  const markerToEntry = useRef(new Map<google.maps.marker.AdvancedMarkerElement, MarkerEntry>());
  const clusterEntries = useRef(new Set<ClusterEntry>());
  const fittedKey = useRef<string | null>(null);
  const handledFocus = useRef<number | null>(null);

  const applySelection = () => {
    const selected = latest.current.selectedId;
    for (const e of entries.current.values()) setElementSelected(e.element, selected !== null && e.ids.has(selected));
    for (const c of clusterEntries.current) {
      if (!c.element.isConnected && clusterEntries.current.size > 200) clusterEntries.current.delete(c);
      else setElementSelected(c.element, selected !== null && c.ids.has(selected));
    }
  };

  // 地図とmarkerライブラリが使えるようになったらクラスタラーを1つだけ作る。
  useEffect(() => {
    if (!map || !markerLib) return;
    const photoEntries = entries.current;
    const toEntry = markerToEntry.current;
    const clusters = clusterEntries.current;

    const instance = new MarkerClusterer({
      map,
      markers: [],
      algorithm: new SuperClusterAlgorithm(CLUSTER_OPTIONS),
      renderer: {
        render: ({ position, markers }) => {
          const photos = sortPhotosDescByTakenAt(
            (markers ?? []).flatMap((m) => toEntry.get(m as google.maps.marker.AdvancedMarkerElement)?.group.photos ?? []),
          );
          // 代表写真は撮影日時が最も新しい写真。
          const representative = pickRepresentativePhoto(photos);
          const element = createMarkerElement({
            name: representative ? photoName(representative) : '',
            thumbnailUrl: representative ? latest.current.thumbnailUrl(representative) : null,
            count: photos.length,
            size: clusterMarkerSize(photos.length),
            cluster: true,
          });
          const entry: ClusterEntry = { element, ids: new Set(photos.map((p) => p.id)) };
          clusters.add(entry);
          const selected = latest.current.selectedId;
          setElementSelected(element, selected !== null && entry.ids.has(selected));
          return new google.maps.marker.AdvancedMarkerElement({
            position,
            content: element,
            title: `${photos.length} photos`,
            gmpClickable: true,
            collisionBehavior: google.maps.CollisionBehavior.REQUIRED,
            zIndex: photos.length,
          });
        },
      },
      // 元の実装と同じく、クラスタのクリックはズームではなく下部シートで中身を見せる。
      onClusterClick: (_event, cluster) => {
        const photos = sortPhotosDescByTakenAt(
          (cluster.markers ?? []).flatMap((m) => toEntry.get(m as google.maps.marker.AdvancedMarkerElement)?.group.photos ?? []),
        );
        const first = photos[0];
        if (!first) return;
        latest.current.onSelect(pickRepresentativePhoto(photos)!.id);
        if (photos.length > 1) latest.current.onOpenSheet(photos);
        else latest.current.onOpenViewer(photos, 0);
      },
    });
    clusterer.current = instance;

    // 地図の空白部分をクリックすると選択を解除する（元の実装と同じ）。
    const clickListener = map.addListener('click', () => latest.current.onSelect(null));

    return () => {
      clickListener.remove();
      instance.clearMarkers();
      instance.setMap(null);
      clusterer.current = null;
      for (const e of photoEntries.values()) e.marker.map = null;
      photoEntries.clear();
      toEntry.clear();
      clusters.clear();
    };
  }, [map, markerLib]);

  // 写真集合が変わったとき、変化したグループのマーカーだけを作り直す。
  useEffect(() => {
    const instance = clusterer.current;
    if (!instance || !markerLib) return;

    const points = props.photos.map(toPhotoPoint).filter((p): p is PhotoPoint => p !== null);
    const groups = groupPhotosByLocation(points);
    const previous = new Map<string, string>();
    for (const [key, e] of entries.current) previous.set(key, groupSignature(e.group));
    const { add, remove } = diffGroups(previous, groups);
    if (add.length === 0 && remove.length === 0) return;

    const removed: google.maps.marker.AdvancedMarkerElement[] = [];
    for (const key of remove) {
      const e = entries.current.get(key);
      if (!e) continue;
      removed.push(e.marker);
      markerToEntry.current.delete(e.marker);
      entries.current.delete(key);
    }
    if (removed.length) instance.removeMarkers(removed, true);

    const created: google.maps.marker.AdvancedMarkerElement[] = [];
    for (const group of add) {
      const representative = pickRepresentativePhoto(group.photos)!;
      const element = createMarkerElement({
        name: photoName(representative),
        thumbnailUrl: latest.current.thumbnailUrl(representative),
        count: group.photos.length,
        size: SINGLE_MARKER_SIZE,
      });
      const marker = new google.maps.marker.AdvancedMarkerElement({
        position: { lat: group.lat, lng: group.lng },
        content: element,
        title: photoName(representative),
        gmpClickable: true,
        collisionBehavior: google.maps.CollisionBehavior.OPTIONAL_AND_HIDES_LOWER_PRIORITY,
        // 新しい写真ほど前面に出す。CSSのz-indexに収まるよう秒単位にする。
        zIndex: Math.floor(representative.takenAtMs / 1000),
      });
      const entry: MarkerEntry = { marker, group, element, ids: new Set(group.photos.map((p) => p.id)) };
      marker.addEventListener('gmp-click', () => {
        const rep = pickRepresentativePhoto(entry.group.photos)!;
        latest.current.onSelect(rep.id);
        if (entry.group.photos.length > 1) latest.current.onOpenSheet(entry.group.photos);
        else latest.current.onOpenViewer(entry.group.photos, 0);
      });
      entries.current.set(group.key, entry);
      markerToEntry.current.set(marker, entry);
      created.push(marker);
    }
    if (created.length) instance.addMarkers(created, true);
    instance.render();
    applySelection();
  }, [props.photos, markerLib, map]);

  // 選択状態の同期（クラスの付け外しのみ）。
  useEffect(applySelection, [props.selectedId]);

  // 地域ごとに1回だけ、写真全体が収まる位置へ合わせる。
  useEffect(() => {
    if (!map || fittedKey.current === props.fitKey) return;
    const points = props.photos.map(toPhotoPoint).filter((p): p is PhotoPoint => p !== null);
    if (points.length === 0) return;
    const bounds = new google.maps.LatLngBounds();
    for (const p of points) bounds.extend({ lat: p.latitude, lng: p.longitude });
    fittedKey.current = props.fitKey;
    map.fitBounds(bounds, 56);
    // 1枚だけのときに拡大しすぎないようにする。
    google.maps.event.addListenerOnce(map, 'idle', () => {
      if ((map.getZoom() ?? 0) > MAX_FIT_ZOOM) map.setZoom(MAX_FIT_ZOOM);
    });
  }, [map, props.photos, props.fitKey]);

  // 一覧で選んだ写真・アップロードした写真へ地図を移動する。写真がまだ届いていなければ届くまで待つ。
  useEffect(() => {
    const focus = props.focus;
    if (!map || !focus || handledFocus.current === focus.nonce) return;
    const target = props.photos.map(toPhotoPoint).find((p) => p?.id === focus.id);
    if (!target) return;
    handledFocus.current = focus.nonce;
    const bounds = map.getBounds();
    const position = { lat: target.latitude, lng: target.longitude };
    if (!bounds || !bounds.contains(position)) map.panTo(position);
  }, [map, props.focus, props.photos]);

  return null;
}
