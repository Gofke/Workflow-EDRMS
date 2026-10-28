import { Body, Controller, Get, HttpCode, Module, Param, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { AuthModule } from '../auth/auth.module';
import { RequireRoles } from '../auth/require-roles.decorator';
import { actorFrom } from '../common/actor';
import { OrgService } from './org.service';

const KINDS = ['CABINET', 'DIRECTORATE', 'DEPARTMENT', 'DISTRICT', 'OFFICE', 'SERVICE'];
const ROLE_CODES = ['MINISTER', 'DIRECTEUR', 'ONDER_DIRECTEUR', 'SUPPORT_STAFF', 'SYS_ADMIN', 'AUDITOR', 'RECORDS_MANAGER'];
const SIGNED_IN = [...ROLE_CODES];

class CreateUnitDto {
  @IsString() @MinLength(2) @MaxLength(40) code: string;
  @IsString() @MinLength(2) @MaxLength(200) name: string;
  @IsOptional() @IsIn(KINDS) kind?: string;
  @IsOptional() @IsUUID('4') parentUnitId?: string;
}

class UpdateUnitDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) name?: string;
  @IsOptional() @IsIn(KINDS) kind?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID('4') parentUnitId?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID('4') headAccountId?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class CreateAccountDto {
  @IsString() @MinLength(2) @MaxLength(200) fullName: string;
  @IsOptional() @IsString() @MaxLength(200) jobPosition?: string;
  @IsEmail({}, { message: 'Enter a valid email address.' }) @MaxLength(320) email: string;
  @IsOptional() @IsUUID('4') unitId?: string;
  @IsArray() @ArrayMaxSize(7) @IsIn(ROLE_CODES, { each: true }) roles: string[];
  @IsString() @MinLength(8) @MaxLength(200) initialPassword: string;
}

class UpdateAccountDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) fullName?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(200) jobPosition?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID('4') unitId?: string | null;
}

class ResetPasswordDto {
  @IsString() @MinLength(8) @MaxLength(200) newPassword: string;
}

@Controller('api/org')
export class OrgController {
  constructor(private readonly org: OrgService) {}

  @Get('units')
  @RequireRoles(...SIGNED_IN)
  units() {
    return this.org.units();
  }

  @Post('units')
  @RequireRoles('SYS_ADMIN')
  @HttpCode(201)
  createUnit(@Body() dto: CreateUnitDto, @Req() request: Request) {
    return this.org.createUnit(actorFrom(request), dto);
  }

  @Put('units/:id')
  @RequireRoles('SYS_ADMIN')
  updateUnit(@Param('id') id: string, @Body() dto: UpdateUnitDto, @Req() request: Request) {
    return this.org.updateUnit(actorFrom(request), id, dto);
  }

  /** The people directory, for choosing an assignee, reviewer or stand-in. */
  @Get('people')
  @RequireRoles(...SIGNED_IN)
  people(@Query('q') q?: string, @Query('role') role?: string, @Query('unitId') unitId?: string) {
    return this.org.people({ q, role, unitId: unitId && /^[0-9a-f-]{36}$/i.test(unitId) ? unitId : undefined });
  }
}

@Controller('api/admin/accounts')
export class AccountAdminController {
  constructor(private readonly org: OrgService) {}

  @Get('directory')
  @RequireRoles('SYS_ADMIN')
  directory() {
    return this.org.people({ includeDisabled: true });
  }

  @Post()
  @RequireRoles('SYS_ADMIN')
  @HttpCode(201)
  create(@Body() dto: CreateAccountDto, @Req() request: Request) {
    return this.org.createAccount(actorFrom(request), dto);
  }

  @Put(':id')
  @RequireRoles('SYS_ADMIN')
  update(@Param('id') id: string, @Body() dto: UpdateAccountDto, @Req() request: Request) {
    return this.org.updateAccount(actorFrom(request), id, dto);
  }

  @Post(':id/reset-password')
  @RequireRoles('SYS_ADMIN')
  @HttpCode(200)
  async reset(@Param('id') id: string, @Body() dto: ResetPasswordDto, @Req() request: Request) {
    await this.org.resetPassword(actorFrom(request), id, dto.newPassword);
    return { reset: true };
  }
}

@Module({
  imports: [AuthModule],
  controllers: [OrgController, AccountAdminController],
  providers: [OrgService],
  exports: [OrgService],
})
export class OrgModule {}
