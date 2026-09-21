import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { DelegationModule } from '../delegation/delegation.module';
import { Account } from '../identity/account.entity';
import { Dossier, DossierLink } from '../records/dossier.entity';
import { WorkflowController } from './workflow.controller';
import { WorkflowEvent } from './workflow.entity';
import { WorkflowService } from './workflow.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Dossier, DossierLink, WorkflowEvent, Account]),
    AuthModule,
    AuditModule,
    DelegationModule,
  ],
  controllers: [WorkflowController],
  providers: [WorkflowService],
})
export class WorkflowModule {}
