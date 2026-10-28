import { Body, Controller, Get, Module, Param, Put, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuthModule } from '../auth/auth.module';
import { RequireRoles } from '../auth/require-roles.decorator';
import { SessionGuard } from '../auth/session.guard';
import { actorFrom } from '../common/actor';
import { UseGuards } from '@nestjs/common';
import { SETTING_DEFAULTS, SettingKey } from './settings.defaults';
import { SettingsService } from './settings.service';
import { IsDefined } from 'class-validator';

class SettingValueDto {
  @IsDefined({ message: 'A value is required.' })
  value: unknown;
}

@Controller('api/settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /** Branding, language and the training banner: the sign-in page needs them. */
  @Get('public')
  publicSettings() {
    return this.settings.publicSettings();
  }

  /** What a signed-in screen needs to know: which features are switched on. */
  @Get('client')
  @UseGuards(SessionGuard)
  async client() {
    const [ai, tasks, workflow, notifications, classification] = await Promise.all([
      this.settings.get('ai'),
      this.settings.get('tasks'),
      this.settings.get('workflow'),
      this.settings.get('notifications'),
      this.settings.get('classification'),
    ]);
    return {
      ai: { provider: ai.provider, features: ai.features, model: ai.provider === 'builtin' ? 'builtin' : ai.model },
      tasks,
      workflow,
      notifications: { pushEnabled: notifications.pushEnabled, smsEnabled: notifications.smsEnabled },
      classification: { defaultLevel: classification.defaultLevel },
    };
  }

  @Get()
  @RequireRoles('SYS_ADMIN')
  all() {
    return this.settings.all();
  }

  @Put(':key')
  @RequireRoles('SYS_ADMIN')
  update(@Param('key') key: string, @Body() dto: SettingValueDto, @Req() request: Request) {
    if (!(key in SETTING_DEFAULTS)) {
      return this.settings.set(actorFrom(request), 'unknown' as SettingKey, dto.value);
    }
    return this.settings.set(actorFrom(request), key as SettingKey, dto.value);
  }
}

@Module({
  imports: [AuthModule],
  controllers: [SettingsController],
})
export class SettingsModule {}
