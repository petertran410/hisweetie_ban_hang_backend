import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateOrderDto, UpdateOrderDto } from '../orders/dto';
import { CreateInvoiceDto, CreateInvoiceFromOrderDto } from '../invoices/dto';
import {
  CreateConsignmentDto,
  CreateInvoiceFromConsignmentDto,
  UpdateConsignmentDto,
} from '../consignments/dto';

describe('document shipping fee DTO validation', () => {
  const cases: Array<[new () => object, Record<string, unknown>]> = [
    [CreateOrderDto, { customerId: 1, items: [] }],
    [UpdateOrderDto, {}],
    [CreateInvoiceDto, { items: [] }],
    [CreateInvoiceFromOrderDto, {}],
    [CreateConsignmentDto, { customerId: 1, items: [] }],
    [UpdateConsignmentDto, {}],
    [CreateInvoiceFromConsignmentDto, {}],
  ];

  it.each(cases)(
    '%p accepts an omitted or zero shipping fee',
    async (Dto, base) => {
      const omitted = plainToInstance(Dto, base);
      const zero = plainToInstance(Dto, { ...base, shippingFee: 0 });

      expect(
        (await validate(omitted)).map((error) => error.property),
      ).not.toContain('shippingFee');
      expect(
        (await validate(zero)).map((error) => error.property),
      ).not.toContain('shippingFee');
    },
  );

  it.each(cases)(
    '%p rejects negative and non-finite shipping fees',
    async (Dto, base) => {
      for (const shippingFee of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const errors = await validate(
          plainToInstance(Dto, { ...base, shippingFee }),
        );
        expect(errors.map((error) => error.property)).toContain('shippingFee');
      }
    },
  );
});
