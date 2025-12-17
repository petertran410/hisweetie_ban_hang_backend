import { Controller, Get } from '@nestjs/common';
import { CustomerGroupsService } from './customer-groups.service';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

@ApiTags('Customer Groups')
@ApiBearerAuth()
@Controller('customer-groups')
export class CustomerGroupsController {
  constructor(private customerGroupsService: CustomerGroupsService) {}

  @Get()
  @ApiOperation({ summary: 'Get all customer groups' })
  findAll() {
    return this.customerGroupsService.findAll();
  }
}
