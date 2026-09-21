import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { DelegationModule } from './delegation/delegation.module';
import { DocumentsModule } from './documents/documents.module';
import { TimelineModule } from './timeline/timeline.module';
import { WorkflowModule } from './workflow/workflow.module';
import { dataSourceOptions } from './config/data-source';
import { HealthController } from './health/health.controller';
import { RecordsModule } from './records/records.module';

@Module({
  imports: [TypeOrmModule.forRoot(dataSourceOptions), AuthModule, AdminModule, RecordsModule, DocumentsModule, DelegationModule, WorkflowModule, TimelineModule],
  controllers: [HealthController],
})
export class AppModule {}
