import { ValidationPipe } from '@nestjs/common';
import { PayablePaymentDto } from './dto';
import { CreateProductionDto } from '../productions/dto/create-production.dto';
import { ReceiveProductionDto } from '../productions/dto/production-factory.dto';
import { ProductFormulaDto } from '../products/dto';

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
  it('normalises and validates the NSX price unit', async () => {
    const base = { isExternal: true, manufacturerId: 1, productId: 10, sourceBranchId: 1, destinationBranchId: 1, quantity: 10, formulaId: null };
    const line = { productId: 3, pricingMode: 'UNIT_PRICE', quantity: 2, unit: 'gói', unitPrice: 1000 };
    const ok = await transform({ ...base, manufacturerMaterials: [{ ...line, priceUnit: ' Gói ' }] }, CreateProductionDto);
    expect(ok.manufacturerMaterials[0].priceUnit).toBe('gói');
    expect(ok.formulaId).toBeNull();
    await expect(transform({ ...base, manufacturerMaterials: [{ ...line, priceUnit: 'lb' }] }, CreateProductionDto)).rejects.toThrow();
  });

  it('accepts both the full external formula and the old mobile formula payload', async () => {
    const components = [{ componentProductId: 2, quantity: 100, inputMode: 'gram' }];
    await expect(transform({ id: 1, name: 'A', isDefault: true, components }, ProductFormulaDto)).resolves.toBeDefined();
    const full = await transform({
      name: 'Gửi', isExternal: true, processingFeePerUnit: 500, currency: 'CNY', components,
      nsxLines: [{ productId: 3, quantity: 0.3, unit: 'G', unitPrice: 250000, priceUnit: 'KG' }],
    }, ProductFormulaDto);
    expect(full.nsxLines[0]).toMatchObject({ unit: 'g', priceUnit: 'kg' });
    await expect(transform({
      name: 'Gửi', isExternal: true, components,
      nsxLines: [{ productId: 3, quantity: 1, unit: 'g', unitPrice: 1, priceUnit: 'kg', pricingMode: 'TOTAL' }],
    }, ProductFormulaDto)).rejects.toThrow();
    await expect(transform({
      name: 'Gửi', isExternal: true, components,
      nsxLines: [{ quantity: 1, unit: 'g', unitPrice: 1, priceUnit: 'kg' }],
    }, ProductFormulaDto)).rejects.toThrow();
  });
});
