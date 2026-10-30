export const MAX_TITLE_LENGTH = 100;

export class PhotoApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = 'PhotoApiError';
  }
}

interface CallParams {
  apiBase: string;
  photoId: string;
  /** Firebase IDトークン。権限の判定はサーバーが行う。 */
  token: string;
  fetchFn?: typeof fetch;
}

async function call(method: 'PATCH' | 'DELETE', { apiBase, photoId, token, fetchFn = fetch }: CallParams, body?: unknown): Promise<Response> {
  let res: Response;
  try {
    res = await fetchFn(`${apiBase}/photos/${encodeURIComponent(photoId)}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new PhotoApiError('network', 0);
  }
  if (!res.ok) {
    let code = 'unknown';
    try {
      const json = (await res.json()) as { error?: { code?: unknown } };
      if (typeof json.error?.code === 'string') code = json.error.code;
    } catch {
      // 本文がJSONでない場合は未知のエラーとして扱う。
    }
    throw new PhotoApiError(code, res.status);
  }
  return res;
}

/** 検証して整えたタイトルを返す。不正なら理由つきで例外（サーバーでも同じ検証を行う）。 */
export function validateTitle(input: string): string {
  const title = input.normalize('NFC').trim();
  if (!title) throw new PhotoApiError('invalid_title_empty', 0);
  if ([...title].length > MAX_TITLE_LENGTH) throw new PhotoApiError('invalid_title_long', 0);
  return title;
}

export async function renamePhoto(params: CallParams, title: string): Promise<string> {
  const res = await call('PATCH', params, { title: validateTitle(title) });
  const body = (await res.json()) as { title?: unknown };
  if (typeof body.title !== 'string') throw new PhotoApiError('invalid_response', res.status);
  return body.title;
}

export async function deletePhoto(params: CallParams): Promise<void> {
  await call('DELETE', params);
}

const MESSAGES: Record<string, string> = {
  invalid_title_empty: '名前を入力してください',
  invalid_title_long: `名前は${MAX_TITLE_LENGTH}文字以内にしてください`,
  invalid_title: '名前に使えない文字が含まれているか、長さが不正です',
  unauthenticated: 'ログインの有効期限が切れました。ログインし直してください',
  not_photo_owner: 'この写真を変更できるのは、投稿者本人または管理者だけです',
  forbidden: 'この操作を行う権限がありません',
  photo_not_found: '写真が見つかりません（すでに削除された可能性があります）',
  unsafe_delete_target: '安全のため削除を中止しました。管理者に連絡してください',
  drive_not_authorized: '保存先（Google Drive）が未設定です。管理者に連絡してください',
  drive_authorization_invalid: '保存先（Google Drive）の認可が切れています。管理者に連絡してください',
  drive_scope_insufficient: '保存先（Google Drive）の権限が不足しています。管理者に再認可を依頼してください',
  drive_parent_inaccessible: 'Google Driveのファイルにアクセスできません。管理者に連絡してください',
  drive_unavailable: 'Google Driveの操作に失敗しました。時間をおいて、もう一度お試しください',
  network: 'ネットワークに接続できませんでした',
};

export function describePhotoError(e: unknown, fallback: string): string {
  return e instanceof PhotoApiError ? (MESSAGES[e.code] ?? fallback) : fallback;
}
