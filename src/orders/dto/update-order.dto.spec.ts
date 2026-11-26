import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { UpdateOrderDto } from './index';

// Cùng cấu hình ValidationPipe toàn cục trong main.ts.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

const validate = (body: unknown) =>
  pipe.transform(body, { type: 'body', metatype: UpdateOrderDto });

describe('UpdateOrderDto — tiền khách trả + TM/CK gửi kèm lưu đơn', () => {
  it('nhận payload lưu đơn từ Bán hàng (payments + paymentNote)', async () => {
    const dto = (await validate({
      description: 'ghi chú',
      payments: [
        { amount: 200000, paymentMethod: 'cash' },
        { amount: 100000, paymentMethod: 'transfer', accountId: 4 },
      ],
      paymentNote: { paymentType: 'cash', amount: 300000 },
    })) as UpdateOrderDto;

    expect(dto.payments).toHaveLength(2);
    expect(dto.payments?.[1].accountId).toBe(4);
    expect(dto.paymentNote).toEqual({ paymentType: 'cash', amount: 300000 });
  });

  it('từ chối khoản thanh toán <= 0 và phương thức lạ', async () => {
    await expect(validate({ payments: [{ amount: 0 }] })).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      validate({ paymentNote: { paymentType: 'card' } }),
    ).rejects.toThrow(BadRequestException);
  });

  it('không cho field lạ trong payments (forbidNonWhitelisted)', async () => {
    await expect(
      validate({ payments: [{ amount: 1000, orderId: 99 }] }),
    ).rejects.toThrow(BadRequestException);
  });
});
