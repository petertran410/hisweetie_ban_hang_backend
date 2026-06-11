import { Module } from '@nestjs/common';
import { BorderGatesController } from './border-gates.controller';
import { BorderGatesService } from './border-gates.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [BorderGatesController],
  providers: [BorderGatesService],
  exports: [BorderGatesService],
})
export class BorderGatesModule {}
