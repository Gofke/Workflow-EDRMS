import { Body, Controller, Get, HttpCode, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { AuthenticatedUser, LoginDto, MfaCodeDto } from './dto';
import { MfaService } from './mfa.service';
import { SessionGuard } from './session.guard';

/** A password checked for a two-step account stays valid this long. */
const PENDING_MFA_MS = 5 * 60 * 1000;

function contextOf(request: Request) {
  return {
    ip: (request.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? request.ip ?? null,
    userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
  };
}

function regenerate(request: Request): Promise<void> {
  return new Promise<void>((resolve, reject) =>
    request.session.regenerate((err) => (err ? reject(err) : resolve())),
  );
}

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly mfa: MfaService,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() request: Request): Promise<AuthenticatedUser | { mfaRequired: true }> {
    const context = contextOf(request);
    const outcome = await this.authService.authenticate(dto.email, dto.password, context);
    // Regenerate the session identifier on sign-in so a value observed before
    // authentication cannot be reused afterwards (session fixation).
    await regenerate(request);
    if (outcome.mfaRequired) {
      request.session.pendingMfaAccountId = outcome.accountId;
      request.session.pendingMfaAt = Date.now();
      return { mfaRequired: true };
    }
    request.session.accountId = outcome.accountId;
    if (outcome.mfaSetupRequired) request.session.mfaSetupRequired = true;
    const user = await this.authService.loadAuthenticatedUser(outcome.accountId);
    return { ...(user as AuthenticatedUser), ...(outcome.mfaSetupRequired ? { mfaSetupRequired: true } : {}) };
  }

  /** The second step: a code from the authenticator app, or a recovery code. */
  @Post('mfa')
  @HttpCode(200)
  async secondFactor(@Body() dto: MfaCodeDto, @Req() request: Request): Promise<AuthenticatedUser> {
    const accountId = request.session.pendingMfaAccountId;
    const at = request.session.pendingMfaAt ?? 0;
    if (!accountId || Date.now() - at > PENDING_MFA_MS) {
      throw new UnauthorizedException('Sign in again: the first step has expired.');
    }
    const user = await this.authService.loadAuthenticatedUser(accountId);
    if (!user) throw new UnauthorizedException('Sign in again.');
    await this.mfa.verifyFor(accountId, `${user.personName} (${user.email})`, dto.code);
    await regenerate(request);
    request.session.accountId = accountId;
    await this.authService.completeSignIn(accountId, contextOf(request), true);
    return user;
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@Req() request: Request): AuthenticatedUser & { mfaSetupRequired?: boolean } {
    return {
      ...(request.authenticatedUser as AuthenticatedUser),
      ...(request.session.mfaSetupRequired ? { mfaSetupRequired: true } : {}),
    };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() request: Request): Promise<{ signedOut: true }> {
    const accountId = request.session?.accountId;
    if (accountId) await this.authService.recordSignOut(accountId);
    await new Promise<void>((resolve) => request.session.destroy(() => resolve()));
    return { signedOut: true };
  }
}
