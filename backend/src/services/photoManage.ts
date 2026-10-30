import { errors } from '../errors.js';
import { log } from '../logger.js';
import type { PhotoManageInfo, PhotoRepository } from '../stores/photoRepository.js';
import type { AuthUser } from './authService.js';
import type { DriveGateway } from './driveGateway.js';
import type { RegionService } from './regions.js';

export const MAX_TITLE_LENGTH = 100;

/** 表示タイトルを検証・正規化する。空・長すぎる・制御文字を含むものは拒否する。 */
export function normalizeTitle(input: unknown): string {
  if (typeof input !== 'string') throw errors.invalidTitle('title must be a string');
  const title = input.normalize('NFC').trim();
  if (!title) throw errors.invalidTitle('title must not be empty');
  if ([...title].length > MAX_TITLE_LENGTH) throw errors.invalidTitle(`title must be at most ${MAX_TITLE_LENGTH} characters`);
  if (/\p{Cc}/u.test(title)) throw errors.invalidTitle('title must not contain control characters');
  return title;
}

export interface PhotoManageDeps {
  photos: PhotoRepository;
  gateway: DriveGateway;
  regions: RegionService;
  /** 地域フォルダーの親（設定値）。削除対象に絶対に含めない。 */
  parentFolderId: string;
}

/** 投稿者本人または管理者の名前変更・削除。権限は検証済みトークン由来のUserだけで判定する。 */
export class PhotoManageService {
  constructor(private readonly deps: PhotoManageDeps) {}

  private async authorize(user: AuthUser, photoId: string): Promise<PhotoManageInfo> {
    const info = await this.deps.photos.getManageInfo(photoId);
    if (!info) throw errors.photoNotFound();
    // 投稿者UIDが無い過去の写真は管理者のみ（空のUIDどうしの一致を許さない）。
    const isOwner = info.uploaderUid !== null && info.uploaderUid === user.uid;
    if (!user.admin && !isOwner) throw errors.notPhotoOwner();
    return info;
  }

  async rename(user: AuthUser, photoId: string, rawTitle: unknown): Promise<{ title: string }> {
    await this.authorize(user, photoId);
    const title = normalizeTitle(rawTitle);
    await this.deps.photos.updateTitle(photoId, title);
    log('INFO', 'photo renamed', { uid: user.uid, photoId });
    return { title };
  }

  /**
   * Driveの原本・サムネイル→Firestoreの順に消す。Firestoreを最後にするため、途中で失敗しても写真は
   * 一覧に残り、再実行で続きから完了できる（Driveで既に無いファイルは削除済みとして扱う）。
   */
  async remove(user: AuthUser, photoId: string): Promise<void> {
    const info = await this.authorize(user, photoId);
    const { gateway, photos, regions, parentFolderId } = this.deps;

    const ids = [info.driveFileId, info.thumbnailDriveFileId].filter((id): id is string => id !== null);
    // 登録済みのファイルIDだけが対象。地域フォルダー・親フォルダーや、同一IDの重複は拒否する。
    const folders = new Set([parentFolderId, ...(await regions.list()).regions.map((r) => r.driveFolderId)]);
    if (new Set(ids).size !== ids.length || ids.some((id) => folders.has(id))) throw errors.unsafeDeleteTarget();

    for (const id of ids) await gateway.deleteFile(id);
    await photos.delete(photoId);
    log('INFO', 'photo deleted', { uid: user.uid, photoId, admin: user.admin });
  }
}
