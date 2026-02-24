import { Module } from '@nestjs/common';
import { AllPackingController } from './all-packing.controller';
import { AllPackingService } from './all-packing.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [AllPackingController],
  providers: [AllPackingService],
  exports: [AllPackingService],
})
export class AllPackingModule {}
