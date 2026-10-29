import { createHash } from 'node:crypto';
import { getFirestore } from 'firebase-admin/firestore';

export interface OAuthStateRecord {
  adminUid: string;
  codeVerifier: string;
  expiresAt: number;
}

/** 認可開始時に発行したstateを1回限り消費できる形で保持する。 */
export interface OAuthStateStore {
  put(state: string, record: OAuthStateRecord): Promise<void>;
  /** 存在すれば削除して返す（再利用不可）。期限切れ・未登録はnull。 */
  consume(state: string): Promise<OAuthStateRecord | null>;
}

const COLLECTION = 'adminOauthStates';
const hash = (state: string) => createHash('sha256').update(state).digest('hex');

/**
 * Firestoreに保存する。stateそのものではなくSHA-256をドキュメントIDにする。
 * クライアントからのアクセスはfirestore.rulesの全拒否ルールで遮断される。
 * `expiresAt`（Timestamp）にTTLポリシーを設定すると期限切れ文書が自動削除される。
 */
export class FirestoreOAuthStateStore implements OAuthStateStore {
  private get col() {
    return getFirestore().collection(COLLECTION);
  }

  async put(state: string, record: OAuthStateRecord): Promise<void> {
    await this.col.doc(hash(state)).create({
      adminUid: record.adminUid,
      codeVerifier: record.codeVerifier,
      expiresAt: new Date(record.expiresAt),
    });
  }

  async consume(state: string): Promise<OAuthStateRecord | null> {
    const ref = this.col.doc(hash(state));
    const db = getFirestore();
    const record = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      tx.delete(ref);
      const d = snap.data()!;
      return { adminUid: d.adminUid as string, codeVerifier: d.codeVerifier as string, expiresAt: d.expiresAt.toMillis() as number };
    });
    return record && record.expiresAt > Date.now() ? record : null;
  }
}

export class MemoryOAuthStateStore implements OAuthStateStore {
  private readonly map = new Map<string, OAuthStateRecord>();
  async put(state: string, record: OAuthStateRecord) {
    this.map.set(hash(state), record);
  }
  async consume(state: string) {
    const key = hash(state);
    const record = this.map.get(key) ?? null;
    this.map.delete(key);
    return record && record.expiresAt > Date.now() ? record : null;
  }
}
