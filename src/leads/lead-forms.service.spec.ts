import { BadRequestException, HttpException } from '@nestjs/common';
import { LeadFormsService } from './lead-forms.service';
import { DEFAULT_LEAD_FORM_FIELDS } from './lead-forms.constants';

const FORM = {
  id: 3,
  slug: 'hoi-cho-2026',
  name: 'Hội chợ 2026',
  title: 'Đăng ký nhận báo giá',
  description: null,
  fields: [
    ...DEFAULT_LEAD_FORM_FIELDS,
    {
      key: 'q_menu',
      label: 'Món quan tâm',
      enabled: true,
      required: false,
      type: 'multiselect',
      options: ['Trà sữa', 'Cà phê'],
    },
  ],
  source: 'direct',
  channelPid: null,
  channelName: 'Hội chợ',
  category: null,
  cskhUserId: 5,
  successMessage: null,
  isActive: true,
  createdById: 1,
};

function makeService(form: any = FORM) {
  const prisma: any = {
    leadForm: {
      findUnique: jest.fn().mockResolvedValue(form),
      create: jest.fn(({ data }) => Promise.resolve({ id: 9, ...data })),
    },
    lead: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(({ data }) => Promise.resolve({ id: 70, ...data })),
      update: jest.fn(({ data }) =>
        Promise.resolve({ id: 60, name: 'Cũ', cskhUserId: 2, ...data }),
      ),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ larkUserId: 'ou_cskh' }),
    },
  };
  const auditLogs: any = { create: jest.fn() };
  const lark: any = {
    im: { message: { create: jest.fn().mockResolvedValue({ code: 0 }) } },
  };
  const config: any = { get: () => 'https://pos.test' };
  const service = new LeadFormsService(prisma, auditLogs, lark, config);
  return { service, prisma, auditLogs, lark };
}

const answers = {
  name: 'Chị Lan',
  phone: '+84 912 345 678',
  province: { provinceCode: '01', provinceName: 'Thành phố Hà Nội' },
  category: 'cafe',
  need: 'Báo giá trà',
  q_menu: ['Cà phê', 'Không có'],
};

describe('LeadFormsService', () => {
  it('submit: tạo lead mới theo cấu hình form, lưu câu trả lời, báo Lark CSKH', async () => {
    const { service, prisma, lark } = makeService();
    const res = await service.submit(
      'hoi-cho-2026',
      { answers },
      { ip: '1.1.1.1' },
    );
    expect(res.ok).toBe(true);
    const data = prisma.lead.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      name: 'Chị Lan',
      phoneNormalized: '0912345678',
      source: 'direct',
      channelName: 'Hội chợ',
      category: 'cafe',
      provinceCode: '01',
      need: 'Báo giá trà',
      cskhUserId: 5,
      createdById: 1,
    });
    expect(data.formSubmissions.create.answers).toContainEqual({
      key: 'q_menu',
      label: 'Món quan tâm',
      value: 'Cà phê',
    });
    expect(lark.im.message.create.mock.calls[0][0].data.receive_id).toBe(
      'ou_cskh',
    );
  });

  it('submit: trùng SĐT lead đang mở → gộp, chỉ điền trường trống', async () => {
    const { service, prisma } = makeService();
    prisma.lead.findFirst.mockResolvedValue({
      id: 60,
      zaloPhone: '0900000000',
      provinceCode: '79',
      need: null,
    });
    await service.submit('hoi-cho-2026', { answers }, { ip: '1.1.1.2' });
    expect(prisma.lead.create).not.toHaveBeenCalled();
    const { data } = prisma.lead.update.mock.calls[0][0];
    expect(data.zaloPhone).toBe('0900000000');
    expect(data.provinceCode).toBeUndefined();
    expect(data.need).toBe('Báo giá trà');
    expect(data.formSubmissions.create.merged).toBe(true);
  });

  it('submit: honeypot → báo thành công, không lưu', async () => {
    const { service, prisma } = makeService();
    const res = await service.submit(
      'hoi-cho-2026',
      { answers, website: 'spam.com' },
      { ip: '1.1.1.3' },
    );
    expect(res.ok).toBe(true);
    expect(prisma.lead.create).not.toHaveBeenCalled();
  });

  it('submit: thiếu trường bắt buộc / SĐT sai → 400', async () => {
    const { service } = makeService();
    await expect(
      service.submit(
        'hoi-cho-2026',
        { answers: { ...answers, name: ' ' } },
        { ip: '1.1.1.4' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.submit(
        'hoi-cho-2026',
        { answers: { ...answers, phone: '123' } },
        { ip: '1.1.1.5' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('submit: vượt giới hạn theo IP → 429', async () => {
    const { service } = makeService();
    for (let i = 0; i < 5; i++)
      await service.submit(
        'hoi-cho-2026',
        { answers: { ...answers, phone: `09123456${70 + i}` } },
        { ip: '2.2.2.2' },
      );
    await expect(
      service.submit('hoi-cho-2026', { answers }, { ip: '2.2.2.2' }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('submit: form đã tắt → 404', async () => {
    const { service } = makeService({ ...FORM, isActive: false });
    await expect(
      service.submit('hoi-cho-2026', { answers }, { ip: '3.3.3.3' }),
    ).rejects.toThrow('Form không tồn tại hoặc đã đóng');
  });

  it('create: không hỏi phân loại bắt buộc → cần phân loại mặc định; Họ tên luôn bắt buộc', async () => {
    const { service, prisma } = makeService();
    prisma.leadForm.findUnique.mockResolvedValue(null);
    const fields = DEFAULT_LEAD_FORM_FIELDS.map((f) =>
      f.key === 'category'
        ? { ...f, enabled: false }
        : { ...f, required: false },
    );
    await expect(
      service.create(
        { name: 'Workshop', source: 'direct', fields },
        { id: 1, name: 'A' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await service.create(
      { name: 'Workshop tháng 11', source: 'direct', fields, category: 'cafe' },
      { id: 1, name: 'A' },
    );
    const data = prisma.leadForm.create.mock.calls[0][0].data;
    expect(data.slug).toBe('workshop-thang-11');
    expect(data.fields.find((f: any) => f.key === 'name')).toMatchObject({
      enabled: true,
      required: true,
    });
  });
});
