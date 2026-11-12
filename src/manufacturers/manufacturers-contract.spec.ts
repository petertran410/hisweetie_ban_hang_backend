import { ValidationPipe } from '@nestjs/common';
import { PayablePaymentDto } from './dto';
import { CreateProductionDto } from '../productions/dto/create-production.dto';
import { ReceiveProductionDto } from '../productions/dto/production-factory.dto';

const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
const transform = (value: any, metatype: any) => pipe.transform(value, { type: 'body', metatype });

describe('external production request boundary', () => {
  it('accepts opaque manufacturer material without a productId, quantity or unit price', async () => {
    const input = { isExternal: true, manufacturerId: 1, productId: 10, sourceBranchId: 1, destinationBranchId: 1, quantity: 160,
      ownMaterials: [{ productId: 10, quantity: 80, unit: 'kg' }],
      manufacturerMaterials: [{ pricingMode: 'TOTAL', amount: 5000 }] };
    await expect(transform(input, CreateProductionDto)).resolves.toBeDefined();
    await expect(transform({ manufacturerMaterials: input.manufacturerMaterials }, ReceiveProductionDto)).resolves.toBeDefined();
  });

  it('rejects negative, unknown and non-finite allocation amounts', async () => {
    const input = { requestKey: 'a', totalAmount: 100, branchId: 1, method: 'cash', allocations: [{ targetType: 'production', targetId: 2, amount: -1 }] };
    await expect(transform(input, PayablePaymentDto)).rejects.toThrow();
    await expect(transform({ ...input, allocations: [{ targetType: 'production', targetId: 2, amount: 10, status: 1 }] }, PayablePaymentDto)).rejects.toThrow();
    await expect(transform({ ...input, totalAmount: Infinity }, PayablePaymentDto)).rejects.toThrow();
  });
});
