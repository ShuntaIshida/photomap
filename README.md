
# Photomap

Photomap is a collaborative, location-based photo mapping web application for fieldwork.

## Features

- Region-based map routes for Yurihonjo, Akita, and Noshiro
- Responsive map and photo-list workspace
- Google Maps JavaScript API integration (optional during local development)
- GitHub Pages SPA fallback for direct links and page reloads

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
- `.github/workflows/deploy-pages.yml` — GitHub Pages deployment

## Status

Phase 1 is implemented. Authentication, Firestore data, photo uploads, and the Cloud Run API are planned for later phases.

## Local development

Requirements: Node.js 22 or later and npm.

```sh
cd frontend
npm ci
npm run dev
```

Open the URL printed by Vite. Region routes are `/yurihonjo`, `/akita`, and `/noshiro`. Without a Maps API key, the app shows a map setup prompt while the rest of the interface remains usable.

To enable the interactive map, create `frontend/.env.local`:

```dotenv
VITE_BASE_PATH=/
VITE_GOOGLE_MAPS_API_KEY=your-browser-api-key
# Optional: VITE_GOOGLE_MAPS_MAP_ID=your-map-id
```

Do not commit `.env.local`. The Maps key is a browser key, not a server secret; restrict it in Google Cloud Console to the Maps JavaScript API and the HTTP referrers `http://localhost:5173/*` and `https://shuntaishida.github.io/photomap/*`. Add the production domain if one is introduced.

## GitHub Pages

Published site: <https://shuntaishida.github.io/photomap/>

The workflow builds `frontend/` and deploys on every push to `main`. In the repository's **Settings → Pages**, set the build and deployment source to **GitHub Actions**. Under **Settings → Secrets and variables → Actions → Variables**, add:

- `VITE_GOOGLE_MAPS_API_KEY`: restricted browser API key (optional; map setup prompt is shown when unset)
- `VITE_GOOGLE_MAPS_MAP_ID`: optional Google Maps map ID
- `VITE_BASE_PATH`: `/photomap/` for the project site; use `/` when deploying on a root domain

The workflow defaults `VITE_BASE_PATH` to `/photomap/`. `frontend/vite.config.ts` uses this value as Vite's asset base, and React Router uses the same base as its basename. The `404.html` fallback preserves region routes on direct navigation and reloads. On a future custom root domain, set `VITE_BASE_PATH` to `/` and add that domain to the Maps API key's referrer restrictions.

## Google Cloud setup for Phase 1

In Google Cloud Console, select project `photomap-app1`, enable billing, and enable **Maps JavaScript API**. Create a browser API key with both an API restriction for Maps JavaScript API and website restrictions for local development and the published site above. Configure an optional map ID in Google Maps Platform if a customized map style is needed. No OAuth secrets or server credentials are used by Phase 1.
