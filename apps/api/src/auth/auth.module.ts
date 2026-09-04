import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { PasswordResetService } from './password-reset.service';
import { DeliveryService } from '../common/delivery.service';
import { AuthController } from './auth.controller';

@Module({
  // Secrets are passed per-sign/verify call rather than configured once, so the
  // access and refresh keys stay distinct.
  imports: [JwtModule.register({})],
  providers: [AuthService, PasswordResetService, DeliveryService],
  controllers: [AuthController],
  exports: [AuthService, PasswordResetService, DeliveryService],
})
export class AuthModule {}
