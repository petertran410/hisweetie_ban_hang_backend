import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import request = require('supertest');
import { ProductionsController } from './productions.controller';
import { ProductionsService } from './productions.service';
import { ProductionCostHistoryService } from './production-cost-history.service';
import { ProductionCostService } from './production-cost.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PermissionCacheService } from '../permission-cache/permission-cache.service';
import { ExternalProductionsService } from '../manufacturers/external-productions.service';
import { FinanceAccessService } from '../auth/finance-access.service';

describe('production cost HTTP authorization boundary', () => {
  let app: INestApplication;
  const user = {
    id: 7,
    permissions: ['productions:view'],
    roles: [] as string[],
  };
  const row: any = {
    id: 1,
    isExternal: true,
    manufacturerId: 5,
    destinationBranchId: 2,
    productId: 10,
    status: 4,
  };
  const prisma: any = {
    production: { findUnique: jest.fn().mockResolvedValue(row) },
    inventory: { findMany: jest.fn().mockResolvedValue([{ branchId: 2 }]) },
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ branchId: 2, userBranches: [], userRoles: [] }),
    },
    $transaction: jest.fn(),
  };
  const auth: any = {
    getPermissionsForBranch: jest
      .fn()
      .mockImplementation(async () => user.permissions),
  };
  const access = new FinanceAccessService(prisma, auth);
  const cost = new ProductionCostService(prisma, access);
  const external = new ExternalProductionsService(prisma, {} as any, {} as any);
  const service = new ProductionsService(
    prisma,
    {} as any,
    {} as any,
    external,
    cost,
  );
  const applySpy = jest.spyOn(service, 'applyFactoryCost');
  const history = {
    history: jest.fn().mockResolvedValue({ data: [], total: 0 }),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ProductionsController],
      providers: [
        { provide: ProductionsService, useValue: service },
        { provide: ProductionCostService, useValue: cost },
        { provide: ProductionCostHistoryService, useValue: history },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          context.switchToHttp().getRequest().user = user;
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.use((req: any, _res: any, next: () => void) => {
      req.user = user;
      next();
    });
    app.useGlobalGuards(
      new PermissionsGuard(new Reflector(), auth, new PermissionCacheService()),
    );
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    user.roles = [];
    user.permissions = ['productions:view'];
    row.manufacturerId = 5;
  });

  it.each([
    ['productions:view'],
    ['productions:update'],
    ['productions:view', 'productions:update'],
  ])(
    'returns 403 for direct apply with %j before service or data changes',
    async (...permissions) => {
      user.permissions = permissions;
      await request(app.getHttpServer())
        .post('/productions/1/apply-cost')
        .send({ basis: 'batch', expectedOldCost: 100 })
        .expect(403);
      expect(applySpy).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('allows history with view only and requires productId at the real DTO boundary', async () => {
    await request(app.getHttpServer())
      .get('/productions/cost-history?productId=10')
      .expect(200);
    await request(app.getHttpServer())
      .get('/productions/cost-history')
      .expect(400);
    await request(app.getHttpServer())
      .get('/productions/cost-history/chart?productId=10&pageSize=101')
      .expect(400);
    expect(history.history).toHaveBeenCalledTimes(1);
  });

  it('blocks a legacy receive newCost bypass for update-only users before creating a purchase order', async () => {
    user.permissions = ['productions:update'];
    row.manufacturerId = null;
    await request(app.getHttpServer())
      .post('/productions/1/receive')
      .send({ newCost: 100 })
      .expect(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects inline cost on the new NSX receipt even when apply permission was granted', async () => {
    user.permissions = ['productions:update', 'productions:apply_cost'];
    await request(app.getHttpServer())
      .post('/productions/1/receive')
      .send({ newCost: 100 })
      .expect(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('requires a valid legacy cost but accepts the batch payload at validation', async () => {
    user.permissions = ['productions:apply_cost'];
    await request(app.getHttpServer())
      .post('/productions/1/apply-cost')
      .send({})
      .expect(400);
    await request(app.getHttpServer())
      .post('/productions/1/apply-cost')
      .send({ basis: 'batch', expectedCosts: [{ branchId: 2, cost: -1 }] })
      .expect(400);
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('accepts the specialized grant, then rejects the same request after revocation', async () => {
    user.permissions = ['productions:apply_cost'];
    applySpy.mockResolvedValueOnce(row);
    await request(app.getHttpServer())
      .post('/productions/1/apply-cost')
      .send({ basis: 'batch', expectedOldCost: 100 })
      .expect(201);
    user.permissions = ['productions:update'];
    await request(app.getHttpServer())
      .post('/productions/1/apply-cost')
      .send({ newCost: 999 })
      .expect(403);
    expect(applySpy).toHaveBeenCalledTimes(1);
  });

  it('preserves Super Admin but does not implicitly grant Admin', async () => {
    user.roles = ['Admin'];
    user.permissions = [];
    await request(app.getHttpServer())
      .post('/productions/1/apply-cost')
      .send({ newCost: 100 })
      .expect(403);
    user.roles = ['Super Admin'];
    applySpy.mockResolvedValueOnce(row);
    await request(app.getHttpServer())
      .post('/productions/1/apply-cost')
      .send({ basis: 'batch' })
      .expect(201);
    expect(applySpy).toHaveBeenCalledTimes(1);
  });
});
