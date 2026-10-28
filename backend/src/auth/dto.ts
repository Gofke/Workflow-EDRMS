import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(320)
  email: string;

  @IsString()
  @MinLength(1, { message: 'Enter your password.' })
  @MaxLength(200)
  password: string;
}

/** The identity the application exposes about the signed-in user. */
export interface AuthenticatedUser {
  accountId: string;
  personName: string;
  email: string;
  jobPosition: string | null;
  organisationalUnit: string | null;
  roles: { code: string; name: string }[];
  /** Phase 3: the unit's identifier, for screens that filter by department. */
  unitId?: string | null;
  /** Phase 3: whether two-step verification is switched on for this account. */
  mfaEnabled?: boolean;
  /** Phase 3: the person's chosen language. */
  language?: 'nl' | 'en';
}

export class MfaCodeDto {
  @IsString()
  @MinLength(6, { message: 'Enter the code from your authenticator app.' })
  @MaxLength(20)
  code: string;
}
