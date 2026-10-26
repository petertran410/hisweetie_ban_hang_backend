import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LarkAuthService } from './lark-auth.service';
import { FinanceAccessService } from './finance-access.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { getJwtSecret, JWT_ALGORITHM } from './jwt-secret.util';
import { sessionConfig } from './session/session.config';
import { SessionModule } from './session/session.module';
import { UsersModule } from '../users/users.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ApprovalLifecycleModule } from '../approval-lifecycle/approval-lifecycle.module';

@Module({
  imports: [
    UsersModule,
    PrismaModule,
    SessionModule,
    ApprovalLifecycleModule,
    PassportModule,
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => {
        const jwtSecret = getJwtSecret(configService);
        // Access token ngắn hạn (mặc định 15 phút) — xem session.config.ts.
        const jwtExpiration = sessionConfig.accessTokenTtl;

        return {
          secret: jwtSecret,
          signOptions: {
            expiresIn: jwtExpiration,
            algorithm: JWT_ALGORITHM,
          },
          verifyOptions: { algorithms: [JWT_ALGORITHM] },
        };
      },
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, LarkAuthService, JwtStrategy, FinanceAccessService],
  exports: [AuthService, FinanceAccessService, JwtStrategy],
})
export class AuthModule {}
