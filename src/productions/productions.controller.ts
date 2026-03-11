import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import { ProductionsService } from './productions.service';
import {
  CreateProductionDto,
  UpdateProductionDto,
  ProductionQueryDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

@ApiTags('Productions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('productions')
export class ProductionsController {
  constructor(private productionsService: ProductionsService) {}

  @Get()
  findAll(@Query() query: ProductionQueryDto) {
    return this.productionsService.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.productionsService.findOne(+id);
  }

  @Post()
  create(@Body() dto: CreateProductionDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.productionsService.create(dto, userId);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateProductionDto) {
    return this.productionsService.update(+id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.productionsService.remove(+id);
  }
}
