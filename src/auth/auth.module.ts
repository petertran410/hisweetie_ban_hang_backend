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
import { UsersModule } from '../users/users.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ApprovalLifecycleModule } from '../approval-lifecycle/approval-lifecycle.module';

@Module({
  imports: [
    UsersModule,
    PrismaModule,
    ApprovalLifecycleModule,
    PassportModule,
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => {
        const jwtSecret = getJwtSecret(configService);
        let jwtExpiration = configService.get<string>('JWT_EXPIRATION') || '7d';

        jwtExpiration = jwtExpiration.trim();

        const validFormats = /^(\d+[smhd]|\d+)$/;
        if (!validFormats.test(jwtExpiration)) {
          console.warn(
            `Invalid JWT_EXPIRATION format: "${jwtExpiration}". Using default: 7d`,
          );
          jwtExpiration = '7d';
        }

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
