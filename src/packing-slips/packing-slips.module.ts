import { Module } from '@nestjs/common';
import { PackingSlipsController } from './packing-slips.controller';
import { PackingSlipsService } from './packing-slips.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [PackingSlipsController],
  providers: [PackingSlipsService],
  exports: [PackingSlipsService],
})
export class PackingSlipsModule {}
