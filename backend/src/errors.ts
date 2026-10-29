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
};
