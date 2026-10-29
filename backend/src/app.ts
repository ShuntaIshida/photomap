import cors from 'cors';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import helmet from 'helmet';
import type { Config } from './config.js';
import { AppError, errors } from './errors.js';
import { log } from './logger.js';
import type { AuthService, AuthUser } from './services/authService.js';
import type { DriveAuthorization } from './services/driveAuthorization.js';
import type { DriveGateway } from './services/driveGateway.js';
import { OAUTH_SCOPES } from './services/googleOAuth.js';
import type { RegionService } from './services/regions.js';

export interface AppDeps {
  config: Config;
  auth: AuthService;
  authorization: DriveAuthorization;
  gateway: DriveGateway;
  regions: RegionService;
}

const BEARER = /^Bearer ([A-Za-z0-9._-]+)$/;

function authenticate(auth: AuthService): RequestHandler {
  return async (req, res, next) => {
    const token = BEARER.exec(req.header('authorization') ?? '')?.[1];
    if (!token) return next(errors.unauthenticated());
    try {
      res.locals.user = await auth.verifyIdToken(token);
      next();
    } catch {
      next(errors.unauthenticated());
    }
  };
}

const requireAdmin: RequestHandler = (_req, res, next) => {
  const user = res.locals.user as AuthUser | undefined;
  next(user?.admin ? undefined : errors.forbidden());
};

const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

const single = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;

const resultPage = (title: string) =>
  `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Photomap</title><body><h1>${title}</h1><p>このタブは閉じて構いません。</p></body></html>`;

export function createApp(deps: AppDeps) {
  const { config, auth, authorization, gateway, regions } = deps;
  const app = express();
  const allowedOrigins = new Set(config.corsAllowedOrigins);

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => cb(null, origin !== undefined && allowedOrigins.has(origin) ? origin : false),
      methods: ['GET', 'POST'],
      allowedHeaders: ['Authorization', 'Content-Type'],
      maxAge: 600,
    }),
  );
  app.use((req, res, next) => {
    const start = Date.now();
    const path = req.originalUrl.split('?')[0];
    res.on('finish', () => {
      // クエリ文字列（OAuthのcode/state）は記録しない。
      if (path !== '/health') {
        log('INFO', 'request', { method: req.method, path, status: res.statusCode, ms: Date.now() - start });
      }
    });
    next();
  });

  // --- 公開 ---
  app.get('/health', noStore, (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Googleからのリダイレクト。認証はIDトークンではなく、管理者が開始時に発行した1回限りのstateで行う。
  app.get('/oauth/google/callback', noStore, async (req, res) => {
    const state = single(req.query.state, 256);
    const code = single(req.query.code, 2048);
    if (req.query.error !== undefined || !state || !code) {
      res.status(400).type('html').send(resultPage('認可を完了できませんでした'));
      return;
    }
    try {
      await authorization.complete({ code, state });
      regions.invalidate();
      res.type('html').send(resultPage('Google Driveの認可が完了しました'));
    } catch (e) {
      const status = e instanceof AppError ? e.status : 500;
      if (!(e instanceof AppError)) log('ERROR', 'oauth callback failed', { error: (e as Error).name });
      res.status(status).type('html').send(resultPage('認可を完了できませんでした'));
    }
  });

  // --- ログイン済みユーザー ---
  app.get('/regions', noStore, authenticate(auth), async (_req, res) => {
    const { regions: list } = await regions.list();
    res.json({ regions: list.map((r) => ({ slug: r.slug })) });
  });

  // --- 管理者のみ ---
  const admin = express.Router();
  admin.use(noStore, authenticate(auth), requireAdmin);

  admin.post('/drive/oauth/start', async (_req, res) => {
    const user = res.locals.user as AuthUser;
    const authorizationUrl = await authorization.start(user.uid);
    log('INFO', 'drive authorization started', { uid: user.uid });
    res.json({ authorizationUrl });
  });

  admin.get('/drive/status', async (_req, res) => {
    res.json({ authorized: await gateway.isAuthorized(), scopes: OAUTH_SCOPES });
  });

  admin.get('/drive/folders', async (_req, res) => {
    res.json(await regions.list({ fresh: true }));
  });

  app.use('/admin', admin);

  app.use((_req, _res, next) => next(new AppError(404, 'not_found', 'Not found')));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    log('ERROR', 'unhandled error', { error: err instanceof Error ? err.name : 'unknown' });
    res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
  });

  return app;
}
