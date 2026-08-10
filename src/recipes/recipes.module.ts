import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AuthModule } from '../auth/auth.module';
import { RecipesController } from './recipes.controller';
import { RecipesService } from './recipes.service';
import { PublicRecipesController } from './public-recipes.controller';
import { PublicRecipesService } from './public-recipes.service';

@Module({
  imports: [PrismaModule, AuditLogsModule, AuthModule],
  controllers: [RecipesController, PublicRecipesController],
  providers: [RecipesService, PublicRecipesService],
  exports: [RecipesService],
})
export class RecipesModule {}
