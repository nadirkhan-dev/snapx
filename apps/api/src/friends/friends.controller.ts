import { Controller, Get, Post, Delete, Param, Body, HttpCode } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FriendsService } from './friends.service';
import { CurrentUser } from '../common/current-user.decorator';

@Controller('friends')
export class FriendsController {
  constructor(private readonly friends: FriendsService) {}

  @Get()
  list(@CurrentUser() me: string) { return this.friends.listFriends(me); }

  @Get('requests')
  requests(@CurrentUser() me: string) { return this.friends.listRequests(me); }

  @Get('blocked')
  blocked(@CurrentUser() me: string) { return this.friends.listBlocked(me); }

  @Get('state/:userId')
  state(@CurrentUser() me: string, @Param('userId') other: string) {
    return this.friends.stateBetween(me, other).then(state => ({ state }));
  }

  @Post('requests')
  // Friend spam is the most common abuse vector on a new social app.
  @Throttle({ default: { limit: 30, ttl: 3_600_000 } })
  request(@CurrentUser() me: string, @Body() body: { userId: string }) {
    return this.friends.sendRequest(me, body.userId);
  }

  @Post('requests/:id/accept')
  @HttpCode(200)
  accept(@CurrentUser() me: string, @Param('id') id: string) {
    return this.friends.accept(me, id);
  }

  @Post('requests/:id/reject')
  @HttpCode(200)
  reject(@CurrentUser() me: string, @Param('id') id: string) {
    return this.friends.reject(me, id);
  }

  @Delete('requests/:id')
  cancel(@CurrentUser() me: string, @Param('id') id: string) {
    return this.friends.cancel(me, id);
  }

  @Delete(':userId')
  remove(@CurrentUser() me: string, @Param('userId') other: string) {
    return this.friends.remove(me, other);
  }

  @Post('blocks')
  @HttpCode(200)
  block(@CurrentUser() me: string, @Body() body: { userId: string }) {
    return this.friends.block(me, body.userId);
  }

  @Delete('blocks/:userId')
  unblock(@CurrentUser() me: string, @Param('userId') other: string) {
    return this.friends.unblock(me, other);
  }
}
