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
}
