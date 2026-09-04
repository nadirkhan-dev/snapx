import { Controller, Get, Post, Body, Param, HttpCode } from '@nestjs/common';
import { CallsService } from './calls.service';
import { CurrentUser } from '../common/current-user.decorator';

/**
 * HTTP alongside the socket, for the cases a socket cannot cover: fetching ICE
 * config before connecting, reading the call log, and ending a call from a
 * client whose socket has already dropped.
 */
@Controller('calls')
export class CallsController {
  constructor(private readonly calls: CallsService) {}

  @Get('ice')
  ice(@CurrentUser() me: string) { return this.calls.iceServers(me); }

  @Get('history')
  history(@CurrentUser() me: string) { return this.calls.history(me); }

  @Post(':id/end')
  @HttpCode(200)
  end(@CurrentUser() me: string, @Param('id') id: string,
      @Body() body: { reason?: 'declined' | 'cancelled' | 'hangup' | 'failed' }) {
    return this.calls.end(me, id, body?.reason);
  }
}
