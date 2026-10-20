import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { CashAdvancesModule } from './cash-advances.module';
import { CashAdvancesService } from './cash-advances.service';
import { CashAdvanceRefundsService } from './cash-advance-refunds.service';
import {
  CashAdvanceRefundsController,
  CashAdvancesController,
} from './cash-advances.controller';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { PermissionCacheModule } from '../permission-cache/permission-cache.module';
import { GoogleStrategy } from '../auth/strategies/google.strategy';

describe('Cash advances module wiring (no DB or network)', () => {
  it('resolves services and controllers without circular dependencies', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PermissionCacheModule,
        ScheduleModule.forRoot(),
        CashAdvancesModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({ $disconnect: jest.fn() })
      .overrideProvider(AuthService)
      .useValue({ getPermissionsForBranch: jest.fn() })
      .overrideProvider(GoogleStrategy)
      .useValue({})
      .compile();
    expect(module.get(CashAdvancesService)).toBeDefined();
    expect(module.get(CashAdvanceRefundsService)).toBeDefined();
    expect(module.get(CashAdvancesController)).toBeDefined();
    expect(module.get(CashAdvanceRefundsController)).toBeDefined();
    await module.close();
  });
});
