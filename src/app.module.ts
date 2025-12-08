// src/app.module.ts
import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ProductsModule } from './products/products.module';
import { ProductVariantsModule } from './product-variants/product-variants.module';
import { CategoriesModule } from './categories/categories.module';
import { CustomerTypesModule } from './customer-types/customer-types.module';
import { CustomersModule } from './customers/customers.module';
import { SuppliersModule } from './suppliers/suppliers.module';
import { OrdersModule } from './orders/orders.module';
import { PurchaseOrdersModule } from './purchase-orders/purchase-orders.module';
import { ReportsModule } from './reports/reports.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    UsersModule,
    ProductsModule,
    ProductVariantsModule,
    CategoriesModule,
    CustomerTypesModule,
    CustomersModule,
    SuppliersModule,
    OrdersModule,
    PurchaseOrdersModule,
    ReportsModule,
  ],
})
export class AppModule {}
