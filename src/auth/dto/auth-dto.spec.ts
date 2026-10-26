import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { AuthService } from '../auth.service';
import { ChangePasswordDto } from './change-password.dto';
import { LoginDto } from './login.dto';
import { UpdateProfileDto } from './update-profile.dto';

/** Cùng cấu hình với ValidationPipe toàn cục trong main.ts. */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});
const validate = (metatype: new () => object, value: unknown) =>
  pipe.transform(value, { type: 'body', metatype });

describe('Auth DTOs', () => {
  it.each([
    [{ userRoles: { create: { roleId: 1 } } }],
    [{ name: 'x', isActive: true }],
    [{ email: 'boss@example.com' }],
    [{ permissionVersion: 99 }],
    [{ password: 'plain' }],
  ])('PUT /auth/profile rejects privileged fields %j', async (body) => {
    await expect(validate(UpdateProfileDto, body)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('PUT /auth/profile accepts name/phone/avatar', async () => {
    await expect(
      validate(UpdateProfileDto, {
        name: 'An',
        phone: '0909',
        avatar: '/a.png',
      }),
    ).resolves.toEqual({ name: 'An', phone: '0909', avatar: '/a.png' });
  });

  it('change-password requires a new password of at least 8 chars', async () => {
    await expect(
      validate(ChangePasswordDto, { oldPassword: 'old', newPassword: '1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      validate(ChangePasswordDto, { oldPassword: 'old' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      validate(ChangePasswordDto, {
        oldPassword: 'old',
        newPassword: '12345678',
      }),
    ).resolves.toBeDefined();
  });

  it('login neutralises object credentials and rejects extra fields', async () => {
    // enableImplicitConversion đổi object → chuỗi: không lọt được bộ lọc Prisma.
    const coerced = (await validate(LoginDto, {
      email: { contains: '@' },
      password: 'x',
    })) as LoginDto;
    expect(typeof coerced.email).toBe('string');
    await expect(
      validate(LoginDto, { email: 'a@b.c', password: 'x', isAdmin: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      validate(LoginDto, { email: 'a@b.c', password: 'x' }),
    ).resolves.toBeDefined();
  });

  it('AuthService.updateProfile only writes name/phone/avatar even if called with more', async () => {
    const update = jest.fn().mockResolvedValue({ id: 1 });
    const service = new AuthService(
      { user: { update } } as any,
      {} as any,
      { invalidateUser: jest.fn() } as any,
      {} as any,
    );
    await service.updateProfile(1, {
      name: 'An',
      userRoles: { create: { roleId: 1 } },
      isActive: true,
    } as any);
    expect(update.mock.calls[0][0].data).toEqual({
      name: 'An',
      phone: undefined,
      avatar: undefined,
    });
  });
});
