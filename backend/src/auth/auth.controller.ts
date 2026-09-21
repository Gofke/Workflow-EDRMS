import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { AuthenticatedUser, LoginDto } from './dto';
import { SessionGuard } from './session.guard';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() request: Request): Promise<AuthenticatedUser> {
    const accountId = await this.authService.authenticate(dto.email, dto.password);

    // Regenerate the session identifier on sign-in so a value observed before
    // authentication cannot be reused afterwards (session fixation).
    await new Promise<void>((resolve, reject) =>
      request.session.regenerate((err) => (err ? reject(err) : resolve())),
    );
    request.session.accountId = accountId;

    const user = await this.authService.loadAuthenticatedUser(accountId);
    return user as AuthenticatedUser;
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@Req() request: Request): AuthenticatedUser {
    return request.authenticatedUser as AuthenticatedUser;
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
