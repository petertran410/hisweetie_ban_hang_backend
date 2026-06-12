import { Module } from '@nestjs/common';
import { ProductionStagesController } from './production-stages.controller';
import { ProductionStagesService } from './production-stages.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [ProductionStagesController],
  providers: [ProductionStagesService],
  exports: [ProductionStagesService],
})
export class ProductionStagesModule {}
