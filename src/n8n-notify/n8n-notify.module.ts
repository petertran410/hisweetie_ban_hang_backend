import { Module } from '@nestjs/common';
import { N8nNotifyService } from './n8n-notify.service';

@Module({
  providers: [N8nNotifyService],
  exports: [N8nNotifyService],
})
export class N8nNotifyModule {}
