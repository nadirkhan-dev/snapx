import { Module } from '@nestjs/common';
import { CallsService } from './calls.service';
import { CallsGateway } from './calls.gateway';
import { CallsController } from './calls.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  providers: [CallsService, CallsGateway],
  controllers: [CallsController],
  exports: [CallsService],
})
export class CallsModule {}
