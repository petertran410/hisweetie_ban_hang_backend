import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { FactoryProductsController } from './factory-products.controller';
import { FactoryProductsService } from './factory-products.service';

@Module({
  imports: [PrismaModule],
  controllers: [FactoryProductsController],
  providers: [FactoryProductsService],
  exports: [FactoryProductsService],
})
export class FactoryProductsModule {}
