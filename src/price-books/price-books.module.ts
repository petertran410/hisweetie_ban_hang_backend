import { Module } from '@nestjs/common';
import { PriceBooksController } from './price-books.controller';
import { PriceBooksService } from './price-books.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [PriceBooksController],
  providers: [PriceBooksService],
  exports: [PriceBooksService],
})
export class PriceBooksModule {}
