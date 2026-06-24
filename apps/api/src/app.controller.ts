import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@sambung/shared';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  // GET /api/health — used by the web shell to prove the FE→API wire.
  @Get('health')
  getHealth(): HealthResponse {
    return this.appService.getHealth();
  }
}
