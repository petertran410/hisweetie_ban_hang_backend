import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { PublicRecipePdfQueryDto, PublicRecipeQueryDto } from './dto';
import { PublicRecipesService } from './public-recipes.service';

@ApiTags('Public Recipes')
@Public()
@Controller('public/recipes')
export class PublicRecipesController {
  constructor(private readonly recipes: PublicRecipesService) {}

  @Get()
  findAll(@Query() query: PublicRecipeQueryDto) {
    return this.recipes.findAll(query);
  }

  @Get(':slug/pdf')
  async pdf(
    @Param('slug') slug: string,
    @Query() query: PublicRecipePdfQueryDto,
    @Res() response: Response,
  ) {
    const { buffer, filename } = await this.recipes.generatePdf(
      slug,
      query.variant,
    );
    response.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length,
    });
    response.send(buffer);
  }

  @Get(':slug')
  findOne(@Param('slug') slug: string) {
    return this.recipes.findOne(slug);
  }
}
