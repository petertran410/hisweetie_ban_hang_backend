import { Module } from '@nestjs/common';
import { FactoriesController } from './factories.controller';
import { FactoriesService } from './factories.service';
import { FactoryImportService } from './factory-import.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [FactoriesController],
  providers: [FactoriesService, FactoryImportService],
  exports: [FactoriesService],
})
export class FactoriesModule {}
