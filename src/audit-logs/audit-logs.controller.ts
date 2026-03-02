import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuditLogsService } from './audit-logs.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

@ApiTags('Audit Logs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('audit-logs')
export class AuditLogsController {
  constructor(private auditLogsService: AuditLogsService) {}

  @Get()
  @RequirePermissions('audit_logs:view')
  findAll(
    @Query('userId') userId?: string,
    @Query('branchId') branchId?: string,
    @Query('resource') resource?: string,
    @Query('action') action?: string,
    @Query('method') method?: string,
    @Query('sessionId') sessionId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.auditLogsService.findAll({
      userId: userId ? +userId : undefined,
      branchId: branchId ? +branchId : undefined,
      resource,
      action,
      method,
      sessionId,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      page: page ? +page : 1,
      limit: limit ? +limit : 50,
    });
  }

  @Post('page-view')
  async logPageView(
    @Body()
    dto: {
      userId: number;
      userName: string;
      branchId?: number;
      path: string;
      timestamp: string;
      sessionId?: string;
    },
    @Req() req: any,
  ) {
    return this.auditLogsService.create({
      userId: dto.userId,
      userName: dto.userName,
      branchId: dto.branchId,
      actionType: 'GET',
      actionCode: 'PAGE_VIEW',
      entityType: 'navigation',
      message: `Page view: ${dto.path}`,
      metadata: {
        timestamp: dto.timestamp,
        path: dto.path,
        sessionId: dto.sessionId,
      },
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.headers['user-agent'],
    });
  }

  @Delete('cleanup')
  @RequirePermissions('audit_logs:delete')
  async cleanup(@Query('months') months?: string) {
    return this.auditLogsService.deleteOldLogs(months ? +months : 6);
  }
}
