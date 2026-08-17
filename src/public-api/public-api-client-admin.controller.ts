import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import {
  CreatePublicApiClientDto,
  UpdatePublicApiClientDto,
} from './dto/manage-public-api-client.dto';
import { PublicApiClientAdminService } from './public-api-client-admin.service';

/**
 * Admin API nội bộ của POS. Đây không phải endpoint `/public/v1` cho đối tác:
 * dùng JWT nhân viên + permission settings:update.
 * Không có DELETE — chỉ deactivate/activate để giữ lịch sử và đối soát.
 */
@Controller('public-api/clients')
@UseGuards(JwtAuthGuard)
@RequirePermissions('settings:update')
export class PublicApiClientAdminController {
  constructor(private readonly service: PublicApiClientAdminService) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Post()
  create(@Body() dto: CreatePublicApiClientDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdatePublicApiClientDto) {
    return this.service.update(id, dto);
  }

  @Post(':id/rotate-secret')
  rotateSecret(@Param('id') id: string) {
    return this.service.rotateSecret(id);
  }

  @Post(':id/activate')
  activate(@Param('id') id: string) {
    return this.service.setActive(id, true);
  }

  @Post(':id/deactivate')
  deactivate(@Param('id') id: string) {
    return this.service.setActive(id, false);
  }
}
