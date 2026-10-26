import { Global, Module } from '@nestjs/common';
import { SessionService } from './session.service';
import { PrismaModule } from '../../prisma/prisma.module';

/**
 * Global để UsersService/RolesService gọi `forceReLogin` mà không cần import
 * AuthModule (AuthModule đã import UsersModule → tránh vòng lặp).
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [SessionService],
  exports: [SessionService],
})
export class SessionModule {}
