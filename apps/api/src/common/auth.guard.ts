import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';

export const Public = () => SetMetadata('isPublic', true);

export interface AuthedRequest extends Request { userId?: string }

/**
 * Bearer-token guard, applied globally.
 *
 * Global-by-default with an explicit `@Public()` opt-out, rather than opt-in
 * per route: forgetting to add a guard silently exposes an endpoint, whereas
 * forgetting `@Public()` produces an obvious 401 during development.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService, private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
      ctx.getHandler(), ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Sign in to continue');

    const payload = await this.auth.verifyAccess(header.slice(7));
    req.userId = payload.sub;
    return true;
  }
}
