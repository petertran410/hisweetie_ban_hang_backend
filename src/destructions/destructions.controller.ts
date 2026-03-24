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
import { DestructionsService } from './destructions.service';
import {
  CreateDestructionDto,
  UpdateDestructionDto,
  DestructionQueryDto,
  CancelDestructionDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

@ApiTags('Destructions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('destructions')
export class DestructionsController {
  constructor(private destructionsService: DestructionsService) {}

  @Get()
  findAll(@Query() query: DestructionQueryDto) {
    return this.destructionsService.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.destructionsService.findOne(+id);
  }

  @Post()
  create(@Body() dto: CreateDestructionDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.destructionsService.create(dto, userId);
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDestructionDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    return this.destructionsService.update(+id, dto, userId);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.destructionsService.remove(+id, userId);
  }

  @Put(':id/cancel')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelDestructionDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    return this.destructionsService.cancelDestruction(+id, dto, userId);
  }
}
