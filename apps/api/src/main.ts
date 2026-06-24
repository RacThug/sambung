import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // All routes under /api — the web dev proxy and prod both target /api/*.
  app.setGlobalPrefix('api');
  // Cross-origin in prod (web on Vercel, api on Railway = different origins).
  // credentials:true so the httpOnly refresh cookie flows. (architecture.md §4.4)
  app.enableCors({ origin: true, credentials: true });
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
