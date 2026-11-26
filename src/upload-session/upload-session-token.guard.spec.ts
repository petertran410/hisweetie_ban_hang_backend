import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UploadSessionTokenGuard } from './upload-session-token.guard';

function contextFor(req: any) {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as any;
}

describe('UploadSessionTokenGuard', () => {
  it('thiếu token → 400, không gọi service', async () => {
    const service = { assertSessionValid: jest.fn() };
    const guard = new UploadSessionTokenGuard(service as any);
    await expect(
      guard.canActivate(contextFor({ params: { id: 's1' }, query: {} })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.assertSessionValid).not.toHaveBeenCalled();
  });

  it('token dạng mảng (?t=a&t=b) → coi như thiếu', async () => {
    const service = { assertSessionValid: jest.fn() };
    const guard = new UploadSessionTokenGuard(service as any);
    await expect(
      guard.canActivate(
        contextFor({ params: { id: 's1' }, query: { t: ['a', 'b'] } }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.assertSessionValid).not.toHaveBeenCalled();
  });

  it('token sai → lỗi của service được giữ nguyên', async () => {
    const service = {
      assertSessionValid: jest
        .fn()
        .mockRejectedValue(new NotFoundException('sai token')),
    };
    const guard = new UploadSessionTokenGuard(service as any);
    await expect(
      guard.canActivate(
        contextFor({ params: { id: 's1' }, query: { t: 'x' } }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(service.assertSessionValid).toHaveBeenCalledWith('s1', 'x');
  });

  it('token đúng → cho qua', async () => {
    const service = { assertSessionValid: jest.fn().mockResolvedValue(true) };
    const guard = new UploadSessionTokenGuard(service as any);
    await expect(
      guard.canActivate(
        contextFor({ params: { id: 's1' }, query: { t: 'tok' } }),
      ),
    ).resolves.toBe(true);
  });
});
