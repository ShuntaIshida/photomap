import { getAuth } from 'firebase-admin/auth';

export interface AuthUser {
  uid: string;
  admin: boolean;
}

export interface AuthService {
  /** 署名・期限・失効を検証する。無効なら例外。 */
  verifyIdToken(token: string): Promise<AuthUser>;
  isAdmin(uid: string): Promise<boolean>;
}

/**
 * 管理者判定は検証済みトークンのカスタムクレーム `admin: true`、または
 * ADMIN_UIDS（UID許可リスト）のみ。メールアドレスは判定に使わない。
 */
export class FirebaseAuthService implements AuthService {
  constructor(private readonly adminUids: ReadonlySet<string>) {}

  async verifyIdToken(token: string): Promise<AuthUser> {
    const decoded = await getAuth().verifyIdToken(token, true);
    return { uid: decoded.uid, admin: decoded.admin === true || this.adminUids.has(decoded.uid) };
  }

  async isAdmin(uid: string): Promise<boolean> {
    const user = await getAuth().getUser(uid);
    if (user.disabled) return false;
    return user.customClaims?.admin === true || this.adminUids.has(uid);
  }
}
