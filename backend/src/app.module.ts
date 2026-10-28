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
import { CoreModule } from './core/core.module';
import { SettingsModule } from './settings/settings.module';
import { AccessModule } from './access/access.module';
import { OrgModule } from './org/org.module';
import { TasksModule } from './tasks/tasks.module';
import { DeadlinesModule } from './deadlines/deadlines.module';
import { LettersModule } from './letters/letters.module';
import { CaseFilesModule } from './casefiles/casefiles.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { AiModule } from './ai/ai.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { OversightModule } from './oversight/oversight.module';
import { DashboardModule } from './dashboard/dashboard.module';

@Module({
  imports: [TypeOrmModule.forRoot(dataSourceOptions), CoreModule, AuthModule, SettingsModule, AccessModule, OrgModule, TasksModule, DeadlinesModule, LettersModule, CaseFilesModule, ApprovalsModule, DashboardModule,
    AiModule, OversightModule, IntegrationsModule, AdminModule, RecordsModule, DocumentsModule, DelegationModule, WorkflowModule, TimelineModule],
  controllers: [HealthController],
})
export class AppModule {}
