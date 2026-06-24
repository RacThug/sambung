import { Injectable } from '@nestjs/common';
import type { HealthResponse } from '@sambung/shared';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello World!';
  }

  getHealth(): HealthResponse {
    return {
      status: 'ok',
      service: 'sambung-api',
      timestamp: new Date().toISOString(),
    };
  }
}
