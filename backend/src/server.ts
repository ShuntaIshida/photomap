import { initializeApp } from 'firebase-admin/app';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { log } from './logger.js';
import { FirebaseAuthService } from './services/authService.js';
import { DriveAuthorization } from './services/driveAuthorization.js';
import { GoogleDriveGateway } from './services/driveGateway.js';
import { GoogleOAuthClient } from './services/googleOAuth.js';
import { SharpImageProcessor } from './imaging/imageProcessor.js';
import { OriginalService } from './services/originals.js';
import { RegionMetaService } from './services/regionMeta.js';
import { FirestoreRegionRepository } from './stores/regionRepository.js';
import { PhotoManageService } from './services/photoManage.js';
import { PhotoUploadService } from './services/photoUpload.js';
import { RegionService } from './services/regions.js';
import { UploadLimiter } from './services/uploadLimiter.js';
import { FirestoreOAuthStateStore } from './stores/oauthStateStore.js';
import { FirestorePhotoRepository } from './stores/photoRepository.js';
import { SecretManagerRefreshTokenStore } from './stores/refreshTokenStore.js';

const config = loadConfig();

// Cloud Run上ではサービスアカウントのADCを使う（秘密鍵ファイルは不要）。
initializeApp({ projectId: config.firebaseProjectId });

const google = new GoogleOAuthClient(config);
const auth = new FirebaseAuthService(config.adminUids);
const tokens = new SecretManagerRefreshTokenStore(config.firebaseProjectId, config.refreshTokenSecretName);
const gateway = new GoogleDriveGateway(config, google, tokens);
const regions = new RegionService(gateway);
const photos = new FirestorePhotoRepository();
const images = new SharpImageProcessor();

const app = createApp({
  config,
  auth,
  gateway,
  regions,
  photos,
  originals: new OriginalService({ photos, gateway, images }),
  regionMeta: new RegionMetaService({ repo: new FirestoreRegionRepository(), regions }),
  manage: new PhotoManageService({ photos, gateway, regions, parentFolderId: config.driveParentFolderId }),
  uploads: new PhotoUploadService({ gateway, regions, photos, images }),
  uploadLimiter: new UploadLimiter(),
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
