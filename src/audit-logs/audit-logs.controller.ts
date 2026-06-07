import { Controller, Delete, Get, Query, UseGuards } from '@nestjs/common';
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
    @Query('entityType') entityType?: string,
    @Query('actionCode') actionCode?: string,
    @Query('category') category?: string,
    @Query('severity') severity?: string,
    @Query('search') search?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.auditLogsService.findAll({
      userId: userId ? +userId : undefined,
      branchId: branchId ? +branchId : undefined,
      entityType,
      actionCode,
      category,
      severity,
      search,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      page: page ? +page : 1,
      limit: limit ? +limit : 50,
    });
  }

  @Delete('cleanup')
  @RequirePermissions('audit_logs:delete')
  async cleanup(@Query('months') months?: string) {
    return this.auditLogsService.deleteOldLogs(months ? +months : 6);
  }
}
