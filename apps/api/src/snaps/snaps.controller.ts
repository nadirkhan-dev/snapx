import { Controller, Get, Post, Body, Param, HttpCode } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SnapsService } from './snaps.service';
import { CurrentUser } from '../common/current-user.decorator';

@Controller('snaps')
export class SnapsController {
  constructor(private readonly snaps: SnapsService) {}

  @Get()
  inbox(@CurrentUser() me: string) { return this.snaps.inbox(me); }

  @Get('sent')
  sent(@CurrentUser() me: string) { return this.snaps.sent(me); }

  @Post()
  @Throttle({ default: { limit: 60, ttl: 3_600_000 } })
  send(@CurrentUser() me: string,
       @Body() body: { mediaId: string; recipientIds: string[]; durationSec?: number }) {
    return this.snaps.send(me, body);
  }

  /** Opening is a state change, not a read — hence POST. */
  @Post(':id/open')
  @HttpCode(200)
  open(@CurrentUser() me: string, @Param('id') id: string) {
    return this.snaps.open(me, id);
  }
}
