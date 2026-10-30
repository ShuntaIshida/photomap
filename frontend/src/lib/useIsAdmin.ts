import { useEffect, useState } from 'react';
import type { User } from 'firebase/auth';

export interface AdminProbe {
  user: Pick<User, 'getIdToken' | 'getIdTokenResult'>;
  apiBase: string;
  fetchFn?: typeof fetch;
}

/**
 * ボタン表示の目安として管理者かどうかを調べる。判定はサーバーの既存ルールそのもの（カスタムクレームまたは
 * ADMIN_UIDS）に任せ、管理者APIが通るかで確認する。実際の編集・削除の可否はサーバーが改めて判定する。
 */
export async function probeAdmin({ user, apiBase, fetchFn = fetch }: AdminProbe): Promise<boolean> {
  try {
    const result = await user.getIdTokenResult();
    if (result.claims.admin === true) return true;
    if (!apiBase) return false;
    const res = await fetchFn(`${apiBase}/admin/drive/status`, { headers: { Authorization: `Bearer ${result.token}` } });
    return res.ok;
  } catch {
    return false;
  }
}

export function useIsAdmin(user: User | null, apiBase: string): boolean {
  const [state, setState] = useState<{ uid: string; admin: boolean } | null>(null);
  const uid = user?.uid ?? null;

  useEffect(() => {
    if (!user || !uid) return;
    let active = true;
    void probeAdmin({ user, apiBase }).then((admin) => active && setState({ uid, admin }));
    return () => {
      active = false;
    };
    // 同じユーザーの間は再確認しない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, apiBase]);

  return !!uid && state?.uid === uid && state.admin;
}
