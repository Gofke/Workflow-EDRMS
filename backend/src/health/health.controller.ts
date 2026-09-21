import { BUILD_VERSION } from '../version';
import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@Controller('api/health')
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Unauthenticated liveness check. Exposes no business or account data. */
  @Get()
  async check(): Promise<{ status: string; version: string; database: string }> {
    let database = 'unreachable';
    try {
      await this.dataSource.query('SELECT 1');
      database = 'reachable';
    } catch {
      database = 'unreachable';
    }
    return { status: 'ok', version: BUILD_VERSION, database };
  }
}
