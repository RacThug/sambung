import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ClsModule } from 'nestjs-cls';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CommonModule } from './common/common.module';
import { DbErrorInterceptor } from './common/db-error/db-error.interceptor';
import { DbModule } from './db/db.module';
import { AuthModule } from './auth/auth.module';
import { PropertiesModule } from './properties/properties.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Opens an AsyncLocalStorage store per request (mounted as middleware) so
    // the guard can seed TenantContext and services can read it ambiently.
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),
    CommonModule,
    DbModule,
    AuthModule,
    PropertiesModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Global on purpose: a constraint violation means the same thing on every
    // route, and a per-module opt-in is a per-module chance to forget. Services
    // that want to handle their own violation just catch it first.
    { provide: APP_INTERCEPTOR, useClass: DbErrorInterceptor },
  ],
})
export class AppModule {}
