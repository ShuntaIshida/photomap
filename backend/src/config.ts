export interface Config {
  port: number;
  firebaseProjectId: string;
  googleClientId: string;
  googleClientSecret: string;
  oauthRedirectUri: string;
  driveParentFolderId: string;
  driveOwnerEmail: string;
  refreshTokenSecretName: string;
  adminUids: ReadonlySet<string>;
  corsAllowedOrigins: readonly string[];
}

// GitHub Pagesのオリジンにはパス（/photomap）を含めない。
const DEFAULT_CORS_ORIGINS = [
  'https://shuntaishida.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

const FOLDER_ID = /^[A-Za-z0-9_-]{10,}$/;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const driveParentFolderId = env.DRIVE_PARENT_FOLDER_ID?.trim() || '17pp81R43EeQOIpaOtNR0IAIRldykz-Fq';
  // Driveクエリに埋め込むため、形式を厳密に検証する。
  if (!FOLDER_ID.test(driveParentFolderId)) {
    throw new Error('DRIVE_PARENT_FOLDER_ID has an invalid format');
  }

  const redirect = new URL(required(env, 'OAUTH_REDIRECT_URI'));
  const isLocal = redirect.hostname === 'localhost' || redirect.hostname === '127.0.0.1';
  if (redirect.protocol !== 'https:' && !isLocal) {
    throw new Error('OAUTH_REDIRECT_URI must use https (http is allowed only for localhost)');
  }

  const origins = list(env.CORS_ALLOWED_ORIGINS);
  const corsAllowedOrigins = origins.length ? origins : DEFAULT_CORS_ORIGINS;
  if (corsAllowedOrigins.includes('*')) throw new Error('CORS_ALLOWED_ORIGINS must not contain "*"');

  return {
    port: Number(env.PORT) || 8080,
    firebaseProjectId: env.FIREBASE_PROJECT_ID?.trim() || 'photomap-app1',
    googleClientId: required(env, 'GOOGLE_OAUTH_CLIENT_ID'),
    googleClientSecret: required(env, 'GOOGLE_OAUTH_CLIENT_SECRET'),
    oauthRedirectUri: redirect.toString(),
    driveParentFolderId,
    driveOwnerEmail: required(env, 'DRIVE_OWNER_EMAIL').toLowerCase(),
    refreshTokenSecretName: env.DRIVE_REFRESH_TOKEN_SECRET?.trim() || 'photomap-drive-refresh-token',
    adminUids: new Set(list(env.ADMIN_UIDS)),
    corsAllowedOrigins,
  };
}
