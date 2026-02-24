import { Module } from '@nestjs/common';
import { PackingLoadingsController } from './packing-loadings.controller';
import { PackingLoadingsService } from './packing-loadings.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [PackingLoadingsController],
  providers: [PackingLoadingsService],
  exports: [PackingLoadingsService],
})
export class PackingLoadingsModule {}
