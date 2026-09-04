import { Controller, Get, Post, Delete, Body, Param, HttpCode } from '@nestjs/common';
import { StoriesService } from './stories.service';
import { CurrentUser } from '../common/current-user.decorator';

@Controller('stories')
export class StoriesController {
  constructor(private readonly stories: StoriesService) {}

  @Get()
  feed(@CurrentUser() me: string) { return this.stories.feed(me); }

  @Post()
  post(@CurrentUser() me: string, @Body() body: {
    mediaId: string; caption?: string; privacy?: 'everyone' | 'friends' | 'custom'; audience?: string[];
  }) { return this.stories.post(me, body); }

  @Post(':id/view')
  @HttpCode(200)
  view(@CurrentUser() me: string, @Param('id') id: string) { return this.stories.view(me, id); }

  @Get(':id/viewers')
  viewers(@CurrentUser() me: string, @Param('id') id: string) { return this.stories.viewers(me, id); }

  @Post(':id/react')
  @HttpCode(200)
  react(@CurrentUser() me: string, @Param('id') id: string, @Body() b: { emoji: string }) {
    return this.stories.react(me, id, b.emoji);
  }

  @Delete(':id')
  remove(@CurrentUser() me: string, @Param('id') id: string) { return this.stories.remove(me, id); }
}
