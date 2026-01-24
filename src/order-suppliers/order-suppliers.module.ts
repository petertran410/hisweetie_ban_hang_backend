import { Module } from '@nestjs/common';
import { OrderSuppliersController } from './order-suppliers.controller';
import { OrderSuppliersService } from './order-suppliers.service';

@Module({
  controllers: [OrderSuppliersController],
  providers: [OrderSuppliersService],
  exports: [OrderSuppliersService],
})
export class OrderSuppliersModule {}
