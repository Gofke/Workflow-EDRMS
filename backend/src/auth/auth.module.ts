import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { Account } from '../identity/account.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RolesGuard } from './roles.guard';
import { SessionGuard } from './session.guard';

@Module({
  imports: [TypeOrmModule.forFeature([Account]), AuditModule],
  controllers: [AuthController],
  providers: [AuthService, SessionGuard, RolesGuard],
  exports: [AuthService, SessionGuard, RolesGuard],
})
export class AuthModule {}
