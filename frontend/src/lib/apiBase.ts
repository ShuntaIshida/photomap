/** Cloud Run APIの既定URL（公開URLで秘密ではない）。ワークフローの既定値と揃える。 */
export const DEFAULT_API_BASE = 'https://photomap-api-506452568070.asia-northeast1.run.app';

/**
 * VITE_API_BASE_URLを正規化する。未設定・空（.env.exampleをそのままコピーした場合など）は既定URLを使う。
 * 末尾スラッシュは除く。
 */
export function resolveApiBase(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  return (value || DEFAULT_API_BASE).replace(/\/+$/, '');
}
