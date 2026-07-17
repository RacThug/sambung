import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { PropertiesController } from './properties.controller';
import { PropertiesRepository } from './properties.repository';
import { PropertiesService } from './properties.service';
import { PublicPropertiesController } from './public-properties.controller';
import { PublicPropertiesService } from './public-properties.service';

// The public property page lives here, beside the CRUD it mirrors, rather than
// in a `public/` module: the public funnel spans property (M1), booking (M2),
// and payment (M3), so a module drawn around "is it authenticated?" would cut
// across every domain boundary architecture §3.2 draws. Both controllers share
// one repository, which is the point - a Visitor's read and an Owner's read
// answer to the same tenant scoping.
@Module({
  imports: [AuthModule, StorageModule], // AuthModule provides JwtAuthGuard
  controllers: [PropertiesController, PublicPropertiesController],
  providers: [PropertiesService, PropertiesRepository, PublicPropertiesService],
})
export class PropertiesModule {}
