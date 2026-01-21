import { Module } from '@nestjs/common';
import { DestructionsController } from './destructions.controller';
import { DestructionsService } from './destructions.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [DestructionsController],
  providers: [DestructionsService],
  exports: [DestructionsService],
})
export class DestructionsModule {}
