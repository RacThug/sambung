import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './auth.guard';

@Module({
  // Empty config — secrets/expiry are passed per sign/verify so access and
  // refresh tokens can use different secrets.
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
  // Export so other feature modules can guard their routes with JwtAuthGuard.
  exports: [JwtAuthGuard, JwtModule],
})
export class AuthModule {}
