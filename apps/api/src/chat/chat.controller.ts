import { Controller, Get, Post, Delete, Body, Param, Query, HttpCode } from '@nestjs/common';
import { ChatService, type SendInput } from './chat.service';
import { CurrentUser } from '../common/current-user.decorator';

/**
 * HTTP alongside the WebSocket.
 *
 * The socket is the fast path; these endpoints are what makes the app work on a
 * bad connection, on first load, and for any future client that has not opened
 * a socket yet. Both call the same service, so the rules cannot drift apart.
 */
@Controller('chat')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get('conversations')
  list(@CurrentUser() me: string) { return this.chat.listConversations(me); }

  @Post('conversations/direct')
  @HttpCode(200)
  async direct(@CurrentUser() me: string, @Body() body: { userId: string }) {
    return { id: await this.chat.directWith(me, body.userId) };
  }

  @Post('conversations/group')
  group(@CurrentUser() me: string, @Body() body: { title: string; memberIds: string[] }) {
    return this.chat.createGroup(me, body.title, body.memberIds);
  }

  @Get('conversations/:id/messages')
  messages(@CurrentUser() me: string, @Param('id') id: string, @Query('before') before?: string) {
    return this.chat.listMessages(me, id, before);
  }

  @Post('messages')
  send(@CurrentUser() me: string, @Body() body: SendInput) {
    return this.chat.send(me, body);
  }

  @Post('conversations/:id/read')
  @HttpCode(200)
  read(@CurrentUser() me: string, @Param('id') id: string) {
    return this.chat.markRead(me, id);
  }

  @Post('conversations/:id/disappearing')
  @HttpCode(200)
  disappearing(@CurrentUser() me: string, @Param('id') id: string,
               @Body() body: { seconds: number | null }) {
    return this.chat.setDisappearing(me, id, body.seconds);
  }

  /* ---- group membership (spec §13) ---- */

  @Get('conversations/:id/members')
  members(@CurrentUser() me: string, @Param('id') id: string) {
    return this.chat.groupDetail(me, id);
  }

  @Post('conversations/:id/members')
  @HttpCode(200)
  addMembers(@CurrentUser() me: string, @Param('id') id: string,
             @Body() body: { userIds: string[] }) {
    return this.chat.addMembers(me, id, body.userIds ?? []);
  }

  @Delete('conversations/:id/members/:userId')
  removeMember(@CurrentUser() me: string, @Param('id') id: string,
               @Param('userId') userId: string) {
    return this.chat.removeMember(me, id, userId);
  }

  @Post('conversations/:id/leave')
  @HttpCode(200)
  leave(@CurrentUser() me: string, @Param('id') id: string) {
    return this.chat.leave(me, id);
  }

  @Post('conversations/:id/mute')
  @HttpCode(200)
  mute(@CurrentUser() me: string, @Param('id') id: string,
       @Body() body: { until: string | null }) {
    return this.chat.mute(me, id, body?.until ?? null);
  }

  @Post('conversations/:id/members/:userId/role')
  @HttpCode(200)
  setRole(@CurrentUser() me: string, @Param('id') id: string,
          @Param('userId') userId: string, @Body() body: { role: 'admin' | 'member' }) {
    return this.chat.setRole(me, id, userId, body.role);
  }

  @Post('conversations/:id/rename')
  @HttpCode(200)
  rename(@CurrentUser() me: string, @Param('id') id: string, @Body() body: { title: string }) {
    return this.chat.renameGroup(me, id, body.title);
  }

  @Delete('messages/:id')
  remove(@CurrentUser() me: string, @Param('id') id: string) {
    return this.chat.deleteMessage(me, id);
  }
}
