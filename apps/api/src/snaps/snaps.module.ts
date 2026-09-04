import { Module } from '@nestjs/common';
import { SnapsService } from './snaps.service';
import { SnapsController } from './snaps.controller';
import { MediaModule } from '../media/media.module';
import { CallsModule } from '../calls/calls.module';
import { CleanupService } from './cleanup.service';

@Module({
  imports: [MediaModule, CallsModule],
  providers: [SnapsService, CleanupService],
  controllers: [SnapsController],
  exports: [SnapsService],
})
export class SnapsModule {}
