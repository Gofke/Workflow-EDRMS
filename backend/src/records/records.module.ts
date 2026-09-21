import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { DelegationModule } from '../delegation/delegation.module';
import { CorrespondenceItem } from './correspondence-item.entity';
import { Dossier, DossierLink, DossierStateEvent } from './dossier.entity';
import { DossierClosureService } from './dossier-closure.service';
import { DuplicateService } from './duplicate.service';
import { DueDateChange, ResponsibilityAssignment } from './responsibility.entity';
import { ResponsibilityService } from './responsibility.service';
import { Account } from '../identity/account.entity';
import { DossierController } from './dossier.controller';
import { DossierService } from './dossier.service';
import { RecordsController } from './records.controller';
import { RegistrationService } from './registration.service';

@Module({
  imports: [TypeOrmModule.forFeature([
      CorrespondenceItem,
      Dossier,
      DossierLink,
      DossierStateEvent,
      ResponsibilityAssignment,
      DueDateChange,
      Account,
    ]),
    AuthModule,
    AuditModule,
    DelegationModule,],
  controllers: [RecordsController, DossierController],
  providers: [RegistrationService, DossierService, ResponsibilityService, DossierClosureService, DuplicateService],
})
export class RecordsModule {}
