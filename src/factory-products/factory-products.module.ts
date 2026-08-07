import { Module } from '@nestjs/common';
import { FactoryProductsController } from './factory-products.controller';
import { FactoryProductsService } from './factory-products.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ExchangeRatesModule } from '../exchange-rates/exchange-rates.module';

@Module({
  imports: [PrismaModule, ExchangeRatesModule],
  controllers: [FactoryProductsController],
  providers: [FactoryProductsService],
  exports: [FactoryProductsService],
})
export class FactoryProductsModule {}
