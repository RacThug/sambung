import './load-env'; // must be first: sets env before any module is evaluated

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { validateEnv } from './validate-env';

async function bootstrap() {
  // Fail fast on a security-relevant misconfiguration BEFORE building the app: in
  // production WEB_BASE_URL must be set, or the OG canonical and payment finish
  // URL fall back to the spoofable request Host (#127). No-op in dev/test.
  validateEnv(process.env);

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Behind the Caddy reverse proxy (prod, single VPS - architecture §7), trust
  // the proxy so `req.ip` is the real client from X-Forwarded-For rather than
  // the loopback address of the proxy. Without this the global rate-limiter
  // (ThrottlerGuard) keys EVERY request to one bucket - all clients throttled
  // together, no per-attacker isolation. Env-gated and OFF by default: in dev/
  // test there is no proxy, and trusting a forged X-Forwarded-For would let a
  // client mint unlimited buckets. Set TRUST_PROXY=1 (one hop) in prod.
  const trustProxyHops = Number(process.env.TRUST_PROXY);
  if (trustProxyHops > 0) {
    app.set('trust proxy', trustProxyHops);
  }

  // All routes under /api - the web dev proxy and prod both target /api/*.
  app.setGlobalPrefix('api');
  // CORS is for the DEV cross-origin hop (Vite :5173 -> api :3000). In prod the
  // SPA and api are same-origin behind Caddy (architecture §4.4/§7), so the
  // refresh cookie is first-party and this is a harmless no-op there.
  // credentials:true so the httpOnly refresh cookie flows in dev.
  app.enableCors({ origin: true, credentials: true });
  // Parse cookies so the refresh endpoint can read the httpOnly refresh token.
  app.use(cookieParser());
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
