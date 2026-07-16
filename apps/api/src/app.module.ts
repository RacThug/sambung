import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClsModule } from 'nestjs-cls';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CommonModule } from './common/common.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { PropertiesModule } from './properties/properties.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Opens an AsyncLocalStorage store per request (mounted as middleware) so
    // the guard can seed TenantContext and services can read it ambiently.
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),
    CommonModule,
    PrismaModule,
    AuthModule,
    PropertiesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
