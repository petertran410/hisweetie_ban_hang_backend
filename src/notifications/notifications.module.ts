import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationFanoutService } from './notification-fanout.service';

@Module({
  imports: [PrismaModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationFanoutService],
  exports: [NotificationsService, NotificationFanoutService],
})
export class NotificationsModule {}
