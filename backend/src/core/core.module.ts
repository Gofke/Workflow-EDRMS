import { Global, Module } from '@nestjs/common';
import { AccessService } from '../access/access.service';
import { AuditModule } from '../audit/audit.module';
import { SettingsService } from '../settings/settings.service';
import { Mailer, PushSender, SmsSender } from './delivery';
import { NotificationService } from './notification.service';
import { SealService } from './seal.service';
import { WorkingDaysService } from './working-days.service';
import { MalwareScanService } from './malware-scan.service';

/**
 * Services every feature module uses. Global, and free of controllers and
 * guards, so that no feature module — authentication included — has to import
 * another feature module to reach them.
 */
@Global()
@Module({
  imports: [AuditModule],
  providers: [SettingsService, AccessService, WorkingDaysService, Mailer, SmsSender, PushSender, NotificationService, SealService, MalwareScanService],
  exports: [AuditModule, SettingsService, AccessService, WorkingDaysService, Mailer, SmsSender, PushSender, NotificationService, SealService, MalwareScanService],
})
export class CoreModule {}
