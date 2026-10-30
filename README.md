
# Photomap

Photomap is a collaborative, location-based photo mapping web application for fieldwork.

## Features

- Independent per-region map pages (`/yurihonjo`, `/nikaho`, ...); the Google Drive `Photomap` folder is the source of truth: each direct subfolder is a valid region URL (via the Cloud Run `GET /regions`), so a new folder works without redeploying and unknown URLs show "region not found". The list is used only to validate URLs. There are no tabs, region lists or other links to other regions; each page shows only its own region's photos
- Responsive map and photo-list workspace
- Google Maps JavaScript API integration (optional during local development)
- GitHub Pages SPA fallback for direct links and page reloads
- Google sign-in / sign-out with Firebase Authentication (popup flow)
- Per-region photo list and map markers read from Cloud Firestore (public read, no login required)
- Photo upload (login required): select multiple JPEG/HEIC photos, GPS is read from EXIF, photos without GPS are rejected with a reason, originals are stored in the matching Google Drive region folder via the Cloud Run API, and a browser-safe JPEG thumbnail is generated (HEIC is converted in the browser)

## Architecture

- Frontend: React + Vite
- Frontend hosting: GitHub Pages
- Authentication: Firebase Authentication
- Database: Cloud Firestore
- Photo storage: Google Drive
- Backend API: Google Cloud Run
- Maps: Google Maps JavaScript API

## Project structure

- `frontend/` — React, TypeScript, and Vite web application
- `backend/` — Cloud Run API (Node.js + TypeScript); see [backend/README.md](backend/README.md)
- `.github/workflows/deploy-pages.yml` — GitHub Pages deployment
- `firestore.rules`, `firebase.json` — Firestore Security Rules

## Status

Phases 1 and 2 are implemented. The Cloud Run backend (Firebase token verification, admin-only Google Drive OAuth, Drive region folder listing, photo upload and thumbnail delivery) is implemented; Phase 3 photo upload (JPEG/HEIC with GPS) is implemented and needs the Drive write scope to be re-authorized after deployment (see [backend/README.md](backend/README.md)). Photos without GPS, manual placement, and Firestore region sync are planned for later.

## Local development

Requirements: Node.js 22 or later and npm.

```sh
cd frontend
npm ci
npm run dev
```

Open the URL printed by Vite. Region routes are `/yurihonjo` and `/nikaho`; `/` redirects to `/yurihonjo`. Without a Maps API key, the app shows a map setup prompt while the rest of the interface remains usable.

To enable the interactive map, create `frontend/.env.local`:

```dotenv
VITE_BASE_PATH=/
VITE_API_BASE_URL=https://photomap-api-506452568070.asia-northeast1.run.app
VITE_GOOGLE_MAPS_API_KEY=your-browser-api-key
# Optional: VITE_GOOGLE_MAPS_MAP_ID=your-map-id
```

Do not commit `.env.local`. The Maps key is a browser key, not a server secret; restrict it in Google Cloud Console to the Maps JavaScript API and the HTTP referrers `http://localhost:5173/*` and `https://shuntaishida.github.io/photomap/*`. Add the production domain if one is introduced.

## Firebase (Phase 2)

Firebase web config values are public client settings, not secrets. They are read from these variables (see `frontend/.env.example`); without them the map still works and the user menu stays in guest mode:

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN` (e.g. `photomap-app1.firebaseapp.com`)
- `VITE_FIREBASE_PROJECT_ID` (`photomap-app1`)
- `VITE_FIREBASE_APP_ID`
- `VITE_FIREBASE_MESSAGING_SENDER_ID` (optional)

Firebase Console setup for project `photomap-app1`:

1. **Project settings → Your apps**: register a Web app and copy its config values into `frontend/.env.local` (never overwritten by this repo) and into GitHub Actions Variables.
2. **Authentication → Sign-in method**: enable **Google** and set the support email.
3. **Authentication → Settings → Authorized domains**: make sure `localhost` and `shuntaishida.github.io` (plus any future custom domain) are listed.
4. **Firestore Database**: create a database in `asia-northeast1` (production mode).
5. Deploy the rules: `firebase deploy --only firestore:rules --project photomap-app1` (or paste `firestore.rules` into the console Rules tab).

The browser key in `VITE_FIREBASE_API_KEY` may be restricted to the HTTP referrers listed above; Firebase Authentication also needs the Identity Toolkit and Token Service APIs allowed if API restrictions are enabled.

### Firestore data model

`regions/{slug}` (document ID equals the slug): `name`, `slug`, `prefecture`, `defaultCenter` (`{lat, lng}`), `defaultZoom`, `sortOrder`, optional `driveFolderId`, `createdAt`, `updatedAt`.

**Which region URLs are valid is decided by Google Drive, not Firestore.** The frontend calls the public `GET /regions` of the Cloud Run API (set `VITE_API_BASE_URL`); each valid direct subfolder of the Drive parent folder `17pp81R43EeQOIpaOtNR0IAIRldykz-Fq` is a region and the folder name is its slug (`^[a-z0-9]+(-[a-z0-9]+)*$`). The list is used only to decide whether `/<slug>` exists; it is never rendered as a region list or menu. `/` redirects to `/yurihonjo`. The display name and initial map position of the current region are resolved as: built-in values for `yurihonjo` (由利本荘) and `nikaho` (にかほ) → the Firestore `regions/<slug>` document (display metadata only) → the folder name with a prefecture-wide map. A `regions` document whose folder is not in Drive (e.g. `akita`, `noshiro`) does not make that URL valid, and nothing in Firestore is deleted or modified.

When `GET /regions` fails, the backend serves its last successful list for up to 24 hours, and the browser falls back to the last list it received (kept in `localStorage`), then to the built-in regions, so a Drive outage never makes valid URLs disappear. An empty successful response is treated as "no regions". If `VITE_API_BASE_URL` is unset, only the built-in regions are available.

Removing or renaming a Drive folder only hides that region's page; its `photos` documents (which reference the old slug in `regionId`) are never deleted and reappear if a folder with the same name returns. Renaming a folder therefore orphans the old photos until a migration is done on purpose. Unknown slugs show a "region not found" message.

Planned (not implemented yet): the Cloud Run backend will also sync the Drive folder list into Firestore `regions` (folder IDs, ordering). Today the Drive list is read live from `GET /regions` and Firestore `regions` documents are optional display metadata for new folders. Note that `regions` is publicly readable, so `driveFolderId` is visible to clients; the folder itself stays private.

`photos/{photoId}`: `regionId` (a region slug), `driveFileId`, `originalFilename`, `mimeType`, `latitude`, `longitude`, `capturedAt` (Timestamp), `capturedAtTimeZoneKnown` (boolean; `false` when EXIF has no offset), `uploadedAt` (Timestamp), `uploaderUid`, `uploaderName`, `width`, `height`, `hasGps`, `locationSource` (`exif` | `manual`), optional `thumbnailDriveFileId`, and (written by the upload API) `contentHash` (SHA-256 of the original) and `sizeBytes`. The document ID is `<slug>-<first 32 hex chars of contentHash>`, so the same photo cannot be uploaded twice to one region. Markers are drawn only when `hasGps` is `true` and both coordinates are numbers. `uploaderUid` comes from the verified Firebase token and the location/time from the original file's EXIF, never from client-supplied fields.

### Security Rules

`regions` and `photos` are readable by anyone (map viewing needs no login) and **not writable from clients**. Registration goes through the Firebase-token-verified Cloud Run API (`POST /regions/<slug>/photos`) using the Admin SDK; the rules themselves need no change for uploads. Photo documents expose `driveFileId`/`thumbnailDriveFileId`, but the Drive files are private and can only be viewed through `GET /photos/<id>/thumbnail` on the API.

### Verifying locally

1. Fill in `frontend/.env.local`, then run `npm run dev` in `frontend/`.
2. Open `http://localhost:5173/yurihonjo`. With no Firestore data, the empty state (`まだ写真がありません`, 0 PHOTOS) is shown.
3. Click the guest button in the top right, sign in with Google in the popup; your name and avatar replace it. The logout icon signs you out.
4. Sign in and use "写真を追加" to upload a GPS-tagged JPEG/HEIC (requires the deployed API with Drive write access; see [backend/README.md](backend/README.md)). Or, for a quick check without the API, in the Console add a `photos` document with `regionId: "yurihonjo"`, `hasGps: true`, numeric `latitude`/`longitude`, and Timestamp `capturedAt`/`uploadedAt`. It appears in the list and as a marker; selecting either highlights both.

## GitHub Pages

Published site: <https://shuntaishida.github.io/photomap/>

The workflow builds `frontend/` and deploys on every push to `main`. In the repository's **Settings → Pages**, set the build and deployment source to **GitHub Actions**. Under **Settings → Secrets and variables → Actions → Variables**, add:

- `VITE_GOOGLE_MAPS_API_KEY`: restricted browser API key (optional; map setup prompt is shown when unset)
- `VITE_GOOGLE_MAPS_MAP_ID`: optional Google Maps map ID
- `VITE_BASE_PATH`: `/photomap/` for the project site; use `/` when deploying on a root domain
- `VITE_API_BASE_URL`: Cloud Run API base URL (defaults in the workflow to `https://photomap-api-506452568070.asia-northeast1.run.app`)
- `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`, `VITE_FIREBASE_MESSAGING_SENDER_ID` (optional): Firebase Web app config

The workflow defaults `VITE_BASE_PATH` to `/photomap/`. `frontend/vite.config.ts` uses this value as Vite's asset base, and React Router uses the same base as its basename. The `404.html` fallback preserves region routes on direct navigation and reloads. On a future custom root domain, set `VITE_BASE_PATH` to `/` and add that domain to the Maps API key's referrer restrictions.

## Google Cloud setup for Phase 1

In Google Cloud Console, select project `photomap-app1`, enable billing, and enable **Maps JavaScript API**. Create a browser API key with both an API restriction for Maps JavaScript API and website restrictions for local development and the published site above. Configure an optional map ID in Google Maps Platform if a customized map style is needed. No OAuth secrets or server credentials are used by Phase 1.
