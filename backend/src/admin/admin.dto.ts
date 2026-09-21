import { IsIn, IsUUID } from 'class-validator';

export class RoleChangeDto {
  @IsUUID('4', { message: 'A valid account identifier is required.' })
  accountId: string;

  @IsIn(['MINISTER', 'DIRECTEUR', 'ONDER_DIRECTEUR', 'SUPPORT_STAFF', 'SYS_ADMIN'], {
    message: 'Unknown functional role.',
  })
  roleCode: string;
}

export class AccountStateDto {
  @IsUUID('4', { message: 'A valid account identifier is required.' })
  accountId: string;
}

export interface AccountSummary {
  accountId: string;
  personName: string;
  email: string;
  organisationalUnit: string | null;
  isEnabled: boolean;
  roles: { code: string; name: string }[];
}
