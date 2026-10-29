import { initializeApp } from 'firebase-admin/app';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { log } from './logger.js';
import { FirebaseAuthService } from './services/authService.js';
import { DriveAuthorization } from './services/driveAuthorization.js';
import { GoogleDriveGateway } from './services/driveGateway.js';
import { GoogleOAuthClient } from './services/googleOAuth.js';
import { RegionService } from './services/regions.js';
import { FirestoreOAuthStateStore } from './stores/oauthStateStore.js';
import { SecretManagerRefreshTokenStore } from './stores/refreshTokenStore.js';

const config = loadConfig();

// Cloud Run上ではサービスアカウントのADCを使う（秘密鍵ファイルは不要）。
initializeApp({ projectId: config.firebaseProjectId });

const google = new GoogleOAuthClient(config);
const auth = new FirebaseAuthService(config.adminUids);
const tokens = new SecretManagerRefreshTokenStore(config.firebaseProjectId, config.refreshTokenSecretName);
const gateway = new GoogleDriveGateway(config, google, tokens);

const app = createApp({
  config,
  auth,
  gateway,
  regions: new RegionService(gateway),
  authorization: new DriveAuthorization({
    config,
    google,
    tokens,
    states: new FirestoreOAuthStateStore(),
    isAdmin: (uid) => auth.isAdmin(uid),
  }),
});

const server = app.listen(config.port, () => log('INFO', 'photomap-api listening', { port: config.port }));

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
