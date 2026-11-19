import {
  Body,
  Controller,
  Get,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsObject } from 'class-validator';
import { Public } from '../auth/decorators/public.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PublicPriceService } from './public-price.service';

type AuthReq = { user: { id: number; name: string } };

export class PublicPriceConfigDto {
  @IsObject()
  config: Record<string, unknown>;
}

/** Cấu hình bảng giá public — tab "Bảng giá public" trong Cài đặt › Mẫu báo giá. */
@ApiTags('Public price page')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('public-price-page')
export class PublicPriceAdminController {
  constructor(private readonly service: PublicPriceService) {}

  private actor(req: AuthReq) {
    return { id: req.user.id, name: req.user.name };
  }

  @Get()
  @RequirePermissions('quote_templates:view')
  get() {
    return this.service.getAdmin();
  }

  @Put()
  @RequirePermissions('quote_templates:update')
  save(@Body() dto: PublicPriceConfigDto, @Req() req: AuthReq) {
    return this.service.saveDraft(dto.config, this.actor(req));
  }

  @Post('preview')
  @RequirePermissions('quote_templates:view')
  preview(@Body() dto: PublicPriceConfigDto) {
    return this.service.preview(dto.config);
  }

  @Post('publish')
  @RequirePermissions('quote_templates:update')
  publish(@Req() req: AuthReq) {
    return this.service.publish(this.actor(req));
  }

  @Post('discard')
  @RequirePermissions('quote_templates:update')
  discard(@Req() req: AuthReq) {
    return this.service.discard(this.actor(req));
  }
}

/** Trang public price.hisweetievietnam.com: bản đã xuất bản. */
@ApiTags('Public price page')
@Public()
@Controller('public/price-page')
export class PublicPriceController {
  constructor(private readonly service: PublicPriceService) {}

  @Get()
  get() {
    return this.service.publicData();
  }
}
