import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PropertyUnitsController, UnitsController } from './units.controller';
import { UnitsRepository } from './units.repository';
import { UnitsService } from './units.service';

// Units get their own module rather than folding into properties: M2 hangs the
// owner calendar (#17) off a unit and M4 hangs four channel endpoints (#28-31),
// so this is where that surface accumulates. Nothing is imported from
// PropertiesModule - the repository queries the `property` table directly, so
// the dependency runs one way and there is no cycle.
@Module({
  imports: [AuthModule], // AuthModule provides JwtAuthGuard
  controllers: [PropertyUnitsController, UnitsController],
  providers: [UnitsService, UnitsRepository],
})
export class UnitsModule {}
