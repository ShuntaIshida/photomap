export const MAP_TYPE_IDS = ['roadmap', 'satellite', 'hybrid', 'terrain'] as const;
export type MapTypeId = (typeof MAP_TYPE_IDS)[number];

export const MAP_TYPE_STORAGE_KEY = 'photomap:mapTypeId';

export function isMapTypeId(value: unknown): value is MapTypeId {
  return typeof value === 'string' && (MAP_TYPE_IDS as readonly string[]).includes(value);
}

export function loadMapType(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): MapTypeId {
  try {
    const v = storage?.getItem(MAP_TYPE_STORAGE_KEY);
    return isMapTypeId(v) ? v : 'roadmap';
  } catch {
    return 'roadmap';
  }
}

export function saveMapType(value: unknown, storage: Pick<Storage, 'setItem'> | undefined = safeStorage()): void {
  if (!isMapTypeId(value)) return;
  try {
    storage?.setItem(MAP_TYPE_STORAGE_KEY, value);
  } catch {
    // プライベートモード等で保存できなくても地図の操作は続ける。
  }
}

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
