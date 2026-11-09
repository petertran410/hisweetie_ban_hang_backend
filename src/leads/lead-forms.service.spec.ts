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
  const config: any = {
    get: (k: string) => (k === 'FRONTEND_URL' ? 'https://pos.test' : undefined),
  };
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
  it('submit: tạo lead mới theo cấu hình form (chưa giao CSKH), lưu câu trả lời, báo nhóm Lark', async () => {
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
      createdById: 1,
    });
    expect(data.cskhUserId).toBeUndefined();
    expect(data.formSubmissions.create.answers).toContainEqual({
      key: 'q_menu',
      label: 'Món quan tâm',
      value: 'Cà phê',
    });
    const msg = lark.im.message.create.mock.calls[0][0];
    expect(msg.params.receive_id_type).toBe('chat_id');
    expect(msg.data.receive_id).toBe('oc_1109627e172997978b63cbbcda6cbf3e');
    expect(JSON.parse(msg.data.content).text).toContain('Lead mới từ form "Hội chợ 2026"');
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

  it('create: giá trị mặc định + ẩn — chuẩn hoá theo loại trường; ẩn cần mặc định; Họ tên/SĐT không có mặc định', async () => {
    const { service, prisma } = makeService();
    prisma.leadForm.findUnique.mockResolvedValue(null);
    const actor = { id: 1, name: 'A' };
    const base = FORM.fields.map((f: any) =>
      f.key === 'category'
        ? { ...f, hidden: true, defaultValue: 'chain' }
        : f.key === 'province'
          ? { ...f, defaultValue: { provinceCode: '79', provinceName: 'TP HCM' } }
          : f.key === 'q_menu'
            ? { ...f, hidden: true, defaultValue: ['Cà phê'] }
            : f.key === 'name'
              ? { ...f, hidden: true, defaultValue: 'X' }
              : f,
    );
    await service.create({ name: 'Hội chợ HCM', source: 'direct', fields: base }, actor);
    const saved = prisma.leadForm.create.mock.calls[0][0].data.fields;
    const by = (k: string) => saved.find((f: any) => f.key === k);
    expect(by('category')).toMatchObject({ hidden: true, required: false, defaultValue: 'chain' });
    expect(by('province').defaultValue).toEqual({ provinceCode: '79', provinceName: 'TP HCM', wardCode: null, wardName: null });
    expect(by('q_menu')).toMatchObject({ hidden: true, defaultValue: ['Cà phê'] });
    // Họ tên: bỏ qua ẩn / mặc định
    expect(by('name').hidden).toBeUndefined();
    expect(by('name').defaultValue).toBeUndefined();

    const bad = (patch: any) =>
      service.create(
        { name: 'X', source: 'direct', fields: FORM.fields.map((f: any) => (f.key === patch.key ? { ...f, ...patch } : f)) },
        actor,
      );
    await expect(bad({ key: 'q_menu', hidden: true })).rejects.toThrow('cần giá trị mặc định');
    await expect(bad({ key: 'q_menu', defaultValue: ['Bánh'] })).rejects.toThrow('không hợp lệ');
    await expect(bad({ key: 'category', defaultValue: 'abc' })).rejects.toThrow('không hợp lệ');
    await expect(bad({ key: 'zaloPhone', enabled: true, defaultValue: '123' })).rejects.toThrow('không hợp lệ');
  });

  it('publicGet / submit: trường ẩn không gửi cho khách, lead nhận giá trị mặc định (bỏ qua giá trị khách gửi)', async () => {
    const fields = FORM.fields.map((f: any) =>
      f.key === 'category'
        ? { ...f, hidden: true, required: false, defaultValue: 'chain' }
        : f.key === 'need'
          ? { ...f, defaultValue: 'Báo giá' }
          : f,
    );
    const { service, prisma } = makeService({ ...FORM, fields });
    const pub = await service.publicGet('hoi-cho-2026');
    expect(pub.fields.map((f) => f.key)).not.toContain('category');
    expect(pub.fields.find((f) => f.key === 'need')?.defaultValue).toBe('Báo giá');
    await service.submit('hoi-cho-2026', { answers: { ...answers, category: 'cafe' } }, { ip: '4.4.4.4' });
    const data = prisma.lead.create.mock.calls[0][0].data;
    expect(data.category).toBe('chain');
    expect(data.formSubmissions.create.answers).toContainEqual({ key: 'category', label: 'Bạn là', value: 'Khách chuỗi' });
  });
});
