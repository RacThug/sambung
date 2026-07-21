import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SettingsController } from './settings.controller';
import { SettingsRepository } from './settings.repository';
import { SettingsService } from './settings.service';

// Exports SettingsService because the photo write reads the gallery cap through
// it (#67): the cap has one owner, and properties asks that owner rather than
// growing its own read of `tenant.gallery_cap`.
@Module({
  imports: [AuthModule], // AuthModule provides JwtAuthGuard
  controllers: [SettingsController],
  providers: [SettingsService, SettingsRepository],
  exports: [SettingsService],
})
export class SettingsModule {}
