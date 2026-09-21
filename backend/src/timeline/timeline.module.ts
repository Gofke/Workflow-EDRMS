import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { Dossier } from '../records/dossier.entity';
import { TimelineController } from './timeline.controller';
import { TimelineService } from './timeline.service';

@Module({
  imports: [TypeOrmModule.forFeature([Dossier]), AuthModule, AuditModule],
  controllers: [TimelineController],
  providers: [TimelineService],
})
export class TimelineModule {}
