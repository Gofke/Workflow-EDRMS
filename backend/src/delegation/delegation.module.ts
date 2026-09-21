import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { Account } from '../identity/account.entity';
import { DelegatedAuthorityGuard } from './delegated-authority.guard';
import { DelegationController } from './delegation.controller';
import { Delegation } from './delegation.entity';
import { DelegationService } from './delegation.service';

@Module({
  imports: [TypeOrmModule.forFeature([Delegation, Account]), AuthModule, AuditModule],
  controllers: [DelegationController],
  providers: [DelegationService, DelegatedAuthorityGuard],
  exports: [DelegationService, DelegatedAuthorityGuard],
})
export class DelegationModule {}
