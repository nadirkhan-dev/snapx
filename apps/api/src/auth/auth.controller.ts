import {
  Body, Controller, Delete, Get, Param, Post, Req, Res, UsePipes, HttpCode,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import {
  registerSchema, loginSchema, resetRequestSchema, resetVerifySchema, resetCompleteSchema,
  type RegisterDto, type LoginDto, type ResetRequestDto, type ResetVerifyDto, type ResetCompleteDto,
} from './dto';
import { PasswordResetService } from './password-reset.service';
import { ZodPipe } from '../common/zod.pipe';
import { Public } from '../common/auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { loadConfig } from '../config/config';

const cfg = loadConfig();

/**
 * The refresh token is delivered as an httpOnly cookie, never in the JSON body.
 * JavaScript cannot read it, so an XSS bug cannot exfiltrate a 30-day
 * credential. The short-lived access token does go to the client, because it
 * must be attached to WebSocket handshakes and cross-origin fetches.
 */
const REFRESH_COOKIE = 'snapx_rt';
const cookieOptions = {
  httpOnly: true,
  secure: cfg.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  /* Must match the path the *browser* requests, not the controller route.
     The global prefix makes every call /api/auth/..., so a cookie scoped to
     '/auth' is simply never sent — the session silently died on every reload
     while login itself looked fine. Native clients hit the same public path,
     so this is correct for them too. */
  path: '/api/auth',
  maxAge: cfg.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
};

const ctxOf = (req: Request) => ({
  ip: req.ip,
  userAgent: req.get('user-agent') ?? undefined,
});

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly reset: PasswordResetService,
  ) {}

  /* ---- password reset (spec §5) ---- */

  @Public()
  @Post('password/forgot')
  @HttpCode(200)
  /* Tight, and per-IP on top of the per-account limit inside the service. This
     endpoint sends email or SMS, so abuse costs real money as well as
     credibility with the delivery provider. */
  @Throttle({ default: { limit: process.env.NODE_ENV === 'test' ? 1000 : 5, ttl: 900_000 } })
  @UsePipes(new ZodPipe(resetRequestSchema))
  forgot(@Body() dto: ResetRequestDto) {
    return this.reset.request(dto.identifier);
  }

  @Public()
  @Post('password/verify')
  @HttpCode(200)
  @Throttle({ default: { limit: process.env.NODE_ENV === 'test' ? 1000 : 15, ttl: 900_000 } })
  @UsePipes(new ZodPipe(resetVerifySchema))
  verifyCode(@Body() dto: ResetVerifyDto) {
    return this.reset.verify(dto.identifier, dto.code);
  }

  @Public()
  @Post('password/reset')
  @HttpCode(200)
  @Throttle({ default: { limit: process.env.NODE_ENV === 'test' ? 1000 : 15, ttl: 900_000 } })
  @UsePipes(new ZodPipe(resetCompleteSchema))
  resetPassword(@Body() dto: ResetCompleteDto) {
    return this.reset.complete(dto.identifier, dto.code, dto.password);
  }

  @Public()
  @Post('register')
  // Signup is expensive (argon2) and a prime abuse target.
  @Throttle({ default: { limit: process.env.NODE_ENV === 'test' ? 1000 : 5, ttl: 3_600_000 } })
  @UsePipes(new ZodPipe(registerSchema))
  async register(@Body() dto: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const out = await this.auth.register(dto, ctxOf(req));
    res.cookie(REFRESH_COOKIE, out.refreshToken, cookieOptions);
    return { user: out.user, accessToken: out.accessToken, expiresIn: out.expiresIn };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  // Per-IP. A per-account limit lives in the service layer in Phase 10; keying
  // only on IP would let one attacker behind a shared NAT lock out a building.
  @Throttle({ default: { limit: process.env.NODE_ENV === 'test' ? 1000 : 10, ttl: 900_000 } })
  @UsePipes(new ZodPipe(loginSchema))
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const out = await this.auth.login(dto.identifier, dto.password, ctxOf(req));
    res.cookie(REFRESH_COOKIE, out.refreshToken, cookieOptions);
    return { user: out.user, accessToken: out.accessToken, expiresIn: out.expiresIn };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // Body fallback exists for the future native clients, which have no cookie jar.
    const token = req.cookies?.[REFRESH_COOKIE] ?? (req.body as { refreshToken?: string })?.refreshToken;
    /* 401, not a 200 carrying an error field. A 200 makes every client treat
       "no session" as success: the browser app read the empty body, set
       status='authed' with an undefined user, and rendered the signed-in shell
       to an anonymous visitor. HTTP status is the contract — a body that
       contradicts it will be believed by somebody. */
    if (!token) throw new UnauthorizedException('No session');
    const out = await this.auth.refresh(token, { ip: req.ip });
    res.cookie(REFRESH_COOKIE, out.refreshToken, cookieOptions);
    return { user: out.user, accessToken: out.accessToken, expiresIn: out.expiresIn };
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[REFRESH_COOKIE];
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    if (token) await this.auth.logout(token);
    return { ok: true };
  }

  @Post('logout-all')
  @HttpCode(200)
  async logoutAll(@CurrentUser() userId: string, @Res({ passthrough: true }) res: Response) {
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    return this.auth.logoutAll(userId);
  }

  @Get('me')
  me(@CurrentUser() userId: string) {
    return this.auth.publicUser(userId);
  }

  @Get('devices')
  devices(@CurrentUser() userId: string) {
    return this.auth.listDevices(userId);
  }

  @Delete('devices/:id')
  revokeDevice(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.auth.revokeDevice(userId, id);
  }
}
