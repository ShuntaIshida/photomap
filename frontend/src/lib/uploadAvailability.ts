export type UploadBlockReason = 'firebase_unconfigured' | 'auth_loading' | 'signed_out' | 'api_unconfigured';

export type UploadAvailability = { enabled: true } | { enabled: false; reason: UploadBlockReason; message: string };

export interface UploadAvailabilityInput {
  /** Firebase Authenticationのログイン中ユーザー（未ログインはnull）。 */
  user: unknown;
  authLoading: boolean;
  authConfigured: boolean;
  apiBase: string;
}

const MESSAGES: Record<UploadBlockReason, string> = {
  firebase_unconfigured: 'ログインを利用できない設定です（Firebase未設定）。',
  auth_loading: 'ログイン状態を確認中…',
  signed_out: '写真を追加するには、右上の「ログイン」からGoogleアカウントでログインしてください。',
  api_unconfigured: 'アップロード先のAPIが設定されていません（VITE_API_BASE_URL）。',
};

/**
 * 「写真を追加」を使えるか。閲覧はログイン不要だが、アップロードはログイン必須（サーバーでもIDトークンを検証する）。
 * 使えない場合は理由を返し、画面に表示する。
 */
export function uploadAvailability({ user, authLoading, authConfigured, apiBase }: UploadAvailabilityInput): UploadAvailability {
  const block = (reason: UploadBlockReason): UploadAvailability => ({ enabled: false, reason, message: MESSAGES[reason] });
  if (!authConfigured) return block('firebase_unconfigured');
  if (authLoading) return block('auth_loading');
  if (!user) return block('signed_out');
  if (!apiBase) return block('api_unconfigured');
  return { enabled: true };
}
