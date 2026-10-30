export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const errors = {
  unauthenticated: () => new AppError(401, 'unauthenticated', 'Valid Firebase ID token required'),
  forbidden: () => new AppError(403, 'forbidden', 'Administrator privileges required'),
  driveNotAuthorized: () =>
    new AppError(503, 'drive_not_authorized', 'Google Drive access has not been authorized by the administrator'),
  driveAuthInvalid: () =>
    new AppError(503, 'drive_authorization_invalid', 'Google Drive authorization was revoked or expired; re-authorize'),
  driveParentInaccessible: () =>
    new AppError(502, 'drive_parent_inaccessible', 'The Drive parent folder is not accessible with the granted authorization'),
  driveUnavailable: () => new AppError(502, 'drive_unavailable', 'Google Drive request failed'),
  driveScopeInsufficient: () =>
    new AppError(503, 'drive_scope_insufficient', 'Google Drive write permission is missing; the administrator must re-authorize'),
  regionNotFound: () => new AppError(404, 'region_not_found', 'Region not found'),
  photoNotFound: () => new AppError(404, 'photo_not_found', 'Photo not found'),
  duplicatePhoto: () => new AppError(409, 'duplicate_photo', 'This photo has already been uploaded to this region'),
  fileTooLarge: () => new AppError(413, 'file_too_large', 'File is too large'),
  unsupportedType: () => new AppError(415, 'unsupported_media_type', 'Only JPEG and HEIC photos are supported'),
  noGps: () => new AppError(422, 'no_gps', 'The photo has no GPS location in its EXIF data'),
  invalidUpload: (message = 'Invalid upload request') => new AppError(400, 'invalid_upload', message),
  rateLimited: () => new AppError(429, 'rate_limited', 'Too many uploads; try again later'),
};
