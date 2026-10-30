export class UploadError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = 'UploadError';
  }
}

export interface UploadParams {
  apiBase: string;
  slug: string;
  /** Firebase IDトークン。Driveの認証情報はフロントエンドには渡らない。 */
  token: string;
  file: File | Blob;
  filename: string;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
}

/**
 * 写真1枚をCloud Runへ送る。保存先はURLの地域slugのみで、DriveのフォルダーIDは送らない
 * （サーバーがslugから解決する）。座標・日時もサーバーが原本のEXIFから読み直す。
 */
export async function uploadPhoto({ apiBase, slug, token, file, filename, signal, fetchFn = fetch }: UploadParams): Promise<{ photoId: string }> {
  const form = new FormData();
  form.append('file', file, filename);

  let res: Response;
  try {
    res = await fetchFn(`${apiBase}/regions/${encodeURIComponent(slug)}/photos`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal,
    });
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') throw e;
    throw new UploadError('network', 0);
  }

  if (!res.ok) {
    let code = 'unknown';
    try {
      const body = (await res.json()) as { error?: { code?: unknown } };
      if (typeof body.error?.code === 'string') code = body.error.code;
    } catch {
      // 本文がJSONでない場合は未知のエラーとして扱う。
    }
    throw new UploadError(code, res.status);
  }

  const body = (await res.json()) as { photoId?: unknown };
  if (typeof body.photoId !== 'string') throw new UploadError('invalid_response', res.status);
  return { photoId: body.photoId };
}

const MESSAGES: Record<string, string> = {
  no_gps: 'GPS位置情報がないためアップロードできません（今回は対象外です）',
  exif_parse_failed: '写真のメタデータ（EXIF）を読み取れませんでした。位置情報が壊れている可能性があります',
  image_decode_failed: '画像を変換できませんでした。ファイルが壊れているか、未対応のHEICの可能性があります',
  image_too_large: '画像の解像度が大きすぎて処理できません',
  conversion_busy: 'サーバーが混み合っています。しばらくしてからお試しください',
  unsupported_media_type: 'JPEGまたはHEIC形式の写真のみアップロードできます',
  file_too_large: 'ファイルサイズが大きすぎます（上限20MB）',
  duplicate_photo: 'この写真はすでにこの地域へアップロードされています',
  rate_limited: 'アップロードが多すぎます。しばらくしてからお試しください',
  unauthenticated: 'ログインの有効期限が切れました。ログインし直してください',
  region_not_found: 'この地域は見つかりません（Driveにフォルダーがありません）',
  invalid_upload: '写真を読み取れませんでした。別のファイルでお試しください',
  drive_not_authorized: '保存先（Google Drive）が未設定です。管理者に連絡してください',
  drive_authorization_invalid: '保存先（Google Drive）の認可が切れています。管理者に連絡してください',
  drive_scope_insufficient: '保存先（Google Drive）の書き込み権限がありません。管理者に再認可を依頼してください',
  drive_parent_inaccessible: '保存先フォルダーにアクセスできません。管理者に連絡してください',
  drive_unavailable: 'Google Driveへの保存に失敗しました。時間をおいてお試しください',
  network: 'ネットワークに接続できませんでした',
};

export function describeUploadError(e: unknown): string {
  if (e instanceof UploadError) {
    if (MESSAGES[e.code]) return MESSAGES[e.code]!;
    // Cloud Runの入口はJSONではなくHTMLで返すため、ステータスから原因を示す。
    if (e.status === 413) return 'ファイルサイズが大きすぎます（上限20MB）';
    if (e.status === 408 || e.status === 504) return 'サーバーの処理がタイムアウトしました。時間をおいて再試行してください';
    if (e.status >= 500) return 'サーバーでエラーが発生しました。時間をおいて再試行してください';
    return 'アップロードに失敗しました';
  }
  return '写真の処理に失敗しました';
}
