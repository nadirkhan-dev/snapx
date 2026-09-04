import { Controller, Get, Post, Body, Param, Query, HttpCode } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ModerationService } from './moderation.service';
import { CurrentUser } from '../common/current-user.decorator';

@Controller()
export class ModerationController {
  constructor(private readonly mod: ModerationService) {}

  /* ---- user-facing ---- */

  @Post('reports')
  // Reporting is free to abuse; a limit keeps the queue usable.
  @Throttle({ default: { limit: 20, ttl: 3_600_000 } })
  report(@CurrentUser() me: string, @Body() body: {
    targetType: string; targetId: string; reason: string; detail?: string;
  }) { return this.mod.report(me, body); }

  /* ---- admin ---- */

  @Get('admin/stats')
  stats(@CurrentUser() me: string) { return this.mod.stats(me); }

  @Get('admin/reports')
  queue(@CurrentUser() me: string, @Query('status') status?: string) {
    return this.mod.queue(me, status ?? 'open');
  }

  @Post('admin/reports/:id/act')
  @HttpCode(200)
  act(@CurrentUser() me: string, @Param('id') id: string,
      @Body() body: { action: string; note?: string }) {
    return this.mod.act(me, id, body.action, body.note);
  }

  @Get('admin/users')
  users(@CurrentUser() me: string, @Query('q') q?: string) { return this.mod.listUsers(me, q); }

  @Get('admin/audit')
  audit(@CurrentUser() me: string) { return this.mod.auditLog(me); }
}
