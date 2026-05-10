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
import { PrintTemplatesService } from './print-templates.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RenderPreviewDto } from './dto';

@ApiTags('Print Templates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('print-templates')
export class PrintTemplatesController {
  constructor(private printTemplatesService: PrintTemplatesService) {}

  @Get()
  @RequirePermissions('print_templates:view')
  findAll(
    @Query('templateFor') templateFor?: string,
    @Query('isActive') isActive?: string,
  ) {
    return this.printTemplatesService.findAll({
      templateFor,
      isActive:
        isActive === 'true' ? true : isActive === 'false' ? false : undefined,
    });
  }

  @Get('variables/:templateFor')
  @RequirePermissions('print_templates:view')
  getVariables(@Param('templateFor') templateFor: string) {
    return this.printTemplatesService.getVariables(templateFor);
  }

  @Get('variables')
  @RequirePermissions('print_templates:view')
  getAllVariables(@Query('templateFor') templateFor?: string) {
    return this.printTemplatesService.getAllVariables(templateFor);
  }

  @Get('by-code/:code')
  @RequirePermissions('print_templates:view')
  findByCode(@Param('code') code: string) {
    return this.printTemplatesService.findByCode(code);
  }

  @Post('preview')
  @RequirePermissions('print_templates:view')
  renderPreview(@Body() dto: RenderPreviewDto) {
    return this.printTemplatesService.renderPreview(
      dto.templateId,
      dto.entityId,
      dto.entityType,
    );
  }

  @Get(':id')
  @RequirePermissions('print_templates:view')
  findOne(@Param('id') id: string) {
    return this.printTemplatesService.findOne(+id);
  }

  @Post()
  @RequirePermissions('print_templates:create')
  create(@Body() data: any, @Req() req: any) {
    return this.printTemplatesService.create({
      ...data,
      createdBy: req.user.id,
    });
  }

  @Put(':id')
  @RequirePermissions('print_templates:update')
  update(@Param('id') id: string, @Body() data: any, @Req() req: any) {
    return this.printTemplatesService.update(+id, {
      ...data,
      updatedBy: req.user.id,
    });
  }

  @Delete(':id')
  @RequirePermissions('print_templates:delete')
  delete(@Param('id') id: string) {
    return this.printTemplatesService.delete(+id);
  }

  @Post('variables')
  @RequirePermissions('print_templates:create')
  createVariable(@Body() data: any) {
    return this.printTemplatesService.createVariable(data);
  }

  @Put('variables/:id')
  @RequirePermissions('print_templates:update')
  updateVariable(@Param('id') id: string, @Body() data: any) {
    return this.printTemplatesService.updateVariable(+id, data);
  }

  @Delete('variables/:id')
  @RequirePermissions('print_templates:delete')
  deleteVariable(@Param('id') id: string) {
    return this.printTemplatesService.deleteVariable(+id);
  }
}
