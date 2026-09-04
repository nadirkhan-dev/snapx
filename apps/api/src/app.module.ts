import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { MediaModule } from './media/media.module';
import { FriendsModule } from './friends/friends.module';
import { SnapsModule } from './snaps/snaps.module';
import { ChatModule } from './chat/chat.module';
import { StoriesModule } from './stories/stories.module';
import { ModerationModule } from './moderation/moderation.module';
import { CallsModule } from './calls/calls.module';
import { StorageModule } from './storage/storage.module';
import { AuthGuard } from './common/auth.guard';

@Module({
  imports: [
    DatabaseModule,
    /* In-process rate limiting. Correct for one instance and wrong for two —
       each process keeps its own counters, so the effective limit multiplies by
       the instance count. Swap the storage for the Redis adapter before
       horizontal scaling; the guard and decorators stay identical. */
    /* The integration suite signs in as several users per file and would trip
       the production limit — which would be a test artefact, not a finding.
       Raised only under NODE_ENV=test; the limiter itself still runs, so a
       genuine throttling regression is still caught by its own test. */
    ThrottlerModule.forRoot([{
      name: 'default',
      ttl: 60_000,
      limit: process.env.NODE_ENV === 'test' ? 5_000 : 120,
    }]),
    StorageModule,
    AuthModule,
    UsersModule,
    MediaModule,
    FriendsModule,
    SnapsModule,
    ChatModule,
    StoriesModule,
    ModerationModule,
    CallsModule,
  ],
  providers: [
    // Order matters: throttle before authenticating, so a flood of bad tokens
    // cannot force an argon2 verify per request.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
