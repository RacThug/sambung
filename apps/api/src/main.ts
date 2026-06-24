import './load-env'; // must be first: sets env before any module is evaluated

import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // All routes under /api — the web dev proxy and prod both target /api/*.
  app.setGlobalPrefix('api');
  // Cross-origin in prod (web on Vercel, api on Railway = different origins).
  // credentials:true so the httpOnly refresh cookie flows. (architecture.md §4.4)
  app.enableCors({ origin: true, credentials: true });
  // Parse cookies so the refresh endpoint can read the httpOnly refresh token.
  app.use(cookieParser());
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
