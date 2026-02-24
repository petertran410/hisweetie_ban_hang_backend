import { Module } from '@nestjs/common';
import { PrintTemplatesController } from './print-templates.controller';
import { PrintTemplatesService } from './print-templates.service';

@Module({
  controllers: [PrintTemplatesController],
  providers: [PrintTemplatesService],
  exports: [PrintTemplatesService],
})
export class PrintTemplatesModule {}
