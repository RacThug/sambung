import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PropertiesController } from './properties.controller';
import { PropertiesRepository } from './properties.repository';
import { PropertiesService } from './properties.service';

@Module({
  imports: [AuthModule], // provides JwtAuthGuard
  controllers: [PropertiesController],
  providers: [PropertiesService, PropertiesRepository],
})
export class PropertiesModule {}
