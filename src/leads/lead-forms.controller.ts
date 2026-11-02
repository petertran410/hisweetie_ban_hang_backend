import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Public } from '../auth/decorators/public.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { LeadFormsService } from './lead-forms.service';
import {
  LeadFormSubmissionsQueryDto,
  SubmitLeadFormDto,
  UpsertLeadFormDto,
} from './dto/lead-form.dto';

/** Quản lý form thu thập lead (CSKH). */
@ApiTags('Lead forms')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('lead-forms')
export class LeadFormsController {
  constructor(private readonly service: LeadFormsService) {}

  private actor(req: any) {
    return { id: req.user.id, name: req.user.name };
  }

  @Get()
  @RequirePermissions('leads:update')
  list() {
    return this.service.list();
  }

  @Post()
  @RequirePermissions('leads:update')
  create(@Body() dto: UpsertLeadFormDto, @Req() req: any) {
    return this.service.create(dto, this.actor(req));
  }

  @Patch(':id')
  @RequirePermissions('leads:update')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpsertLeadFormDto,
    @Req() req: any,
  ) {
    return this.service.update(id, dto, this.actor(req));
  }

  @Delete(':id')
  @RequirePermissions('leads:update')
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.remove(id, this.actor(req));
  }

  @Get(':id/submissions')
  @RequirePermissions('leads:update')
  submissions(
    @Param('id', ParseIntPipe) id: number,
    @Query() q: LeadFormSubmissionsQueryDto,
  ) {
    return this.service.submissions(id, q);
  }
}

/** Form công khai cho khách điền (link / iframe / QR) — không cần đăng nhập. */
@ApiTags('Public lead forms')
@Public()
@Controller('public/lead-forms')
export class PublicLeadFormsController {
  constructor(private readonly service: LeadFormsService) {}

  @Get(':slug')
  get(@Param('slug') slug: string) {
    return this.service.publicGet(slug);
  }

  @Post(':slug/submit')
  submit(
    @Param('slug') slug: string,
    @Body() dto: SubmitLeadFormDto,
    @Req() req: Request,
  ) {
    return this.service.submit(slug, dto, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }
}
