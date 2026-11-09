import {
  CustomerDemandNotificationSnapshot,
  LarkCustomerDemandNotificationService,
} from './lark-customer-demand-notification.service';

describe('LarkCustomerDemandNotificationService', () => {
  let service: LarkCustomerDemandNotificationService;
  let createMessage: jest.Mock;
  let config: { get: jest.Mock };
  let demand: CustomerDemandNotificationSnapshot;

  beforeEach(() => {
    createMessage = jest.fn().mockResolvedValue({ code: 0 });
    config = { get: jest.fn().mockReturnValue('  oc_demand_test  ') };
    service = new LarkCustomerDemandNotificationService(
      { im: { message: { create: createMessage } } } as any,
      config as any,
    );
    jest.spyOn((service as any).logger, 'log').mockImplementation();
    jest.spyOn((service as any).logger, 'warn').mockImplementation();
    demand = {
      id: 99,
      customer: {
        name: 'NLPC Nguyễn An Quận 10, HCM - Mr Thắng (sale 2 - A2)',
      },
      note: 'Giao đầu tháng\nLiên hệ trước khi giao',
      months: [
        {
          id: 10,
          month: '2026-10',
          status: 'CONFIRMED',
          lines: [
            {
              product: { name: 'Thạch Dừa 2kg (10 túi/thùng)', unit: 'Túi' },
              inputQuantity: 300,
              inputUnit: 'CARTON',
              quantityBase: 3000,
            },
            {
              product: { name: 'Thạch Nổ Củ Năng', unit: 'Hộp' },
              inputQuantity: 1.25,
              inputUnit: 'BASE',
              quantityBase: 1.25,
            },
            {
              product: { name: 'Khoai Môn Tím', unit: null },
              inputQuantity: 200,
              inputUnit: 'CARTON',
              quantityBase: 8000,
            },
          ],
        },
      ],
    };
  });

  afterEach(() => jest.restoreAllMocks());

  function sentCard() {
    return JSON.parse(createMessage.mock.calls[0][0].data.content);
  }

  it('gửi một interactive card đúng group với title mới và đủ nội dung theo ảnh', async () => {
    await service.notifyDemandSaved(demand, 'CREATED');

    expect(config.get).toHaveBeenCalledWith('LARK_DEMAND_CUSTOMER_CHAT');
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(createMessage).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_demand_test',
        msg_type: 'interactive',
        content: expect.any(String),
      },
    });
    const card = sentCard();
    expect(card.header).toEqual({
      template: 'carmine',
      title: {
        tag: 'plain_text',
        content: '📣 Thông Báo Demand Khách Chuỗi Mới',
      },
    });
    expect(card.elements[0].text.content).toBe(
      `Demand Tháng 10/2026 :\nTên Khách Hàng: ${demand.customer.name}`,
    );
    expect(card.elements[1].text.content).toBe(
      [
        '1.**Tên Hàng Hóa:** Thạch Dừa 2kg (10 túi/thùng)',
        '**Số lượng:** 300',
        '**Đơn Vị Đặt:** Thùng',
        '**Số lượng quy đổi:** 3000',
        '**ĐVT:** Túi',
      ].join('\n'),
    );
    expect(card.elements[2].text.content).toContain('2.**Tên Hàng Hóa:**');
    expect(card.elements[2].text.content).toContain('**Số lượng:** 1,25');
    expect(card.elements[2].text.content).toContain('**Đơn Vị Đặt:** Hộp');
    expect(card.elements[2].text.content).toContain(
      '**Số lượng quy đổi:** 1,25',
    );
    expect(card.elements[3].text.content).toContain('**ĐVT:** ');
    expect(card.elements[4].text.content).toBe(`**Ghi Chú :** ${demand.note}`);
  });

  it('đổi title khi sửa và luôn có Ghi Chú dù không có nội dung', async () => {
    demand.note = null;
    demand.months[0].month = '2027-01';
    await service.notifyDemandSaved(demand, 'UPDATED');

    const card = sentCard();
    expect(card.header.title.content).toBe('📣 Cập Nhật Demand Khách Chuỗi');
    expect(card.elements[0].text.content).toContain('Demand Tháng 01/2027 :');
    expect(card.elements[4].text.content).toBe('**Ghi Chú :** ');
  });

  it('ưu tiên ghi chú riêng của tháng và giữ bốn chữ số thập phân', async () => {
    demand.months[0].note = 'Ghi chú tháng';
    demand.months[0].lines[0].inputQuantity = 1.2345;
    demand.months[0].lines[0].quantityBase = 12.345;
    await service.notifyDemandSaved(demand, 'UPDATED');

    expect(sentCard().elements[1].text.content).toContain(
      '**Số lượng:** 1,2345',
    );
    expect(sentCard().elements[1].text.content).toContain(
      '**Số lượng quy đổi:** 12,345',
    );
    expect(sentCard().elements[4].text.content).toBe(
      '**Ghi Chú :** Ghi chú tháng',
    );
  });

  it('không cho dữ liệu người dùng trở thành markup hoặc mention Lark', async () => {
    demand.customer.name = '<at id=all></at>';
    demand.months[0].lines[0].product.name = '*Hàng* [mới]';
    demand.note = 'A & B';
    await service.notifyDemandSaved(demand, 'CREATED');

    expect(sentCard().elements[0].text.content).toContain(
      '&lt;at id=all&gt;&lt;/at&gt;',
    );
    expect(sentCard().elements[1].text.content).toContain(
      '\\*Hàng\\* \\[mới\\]',
    );
    expect(sentCard().elements[4].text.content).toBe('**Ghi Chú :** A &amp; B');
  });

  it.each([undefined, '', '   '])(
    'bỏ qua khi env trống (%s)',
    async (chatId) => {
      config.get.mockReturnValue(chatId);
      await expect(
        service.notifyDemandSaved(demand, 'CREATED'),
      ).resolves.toBeUndefined();
      expect(createMessage).not.toHaveBeenCalled();
      expect((service as any).logger.warn).toHaveBeenCalledTimes(1);
    },
  );

  it('chỉ ghi cảnh báo khi Lark trả code lỗi', async () => {
    createMessage.mockResolvedValue({ code: 230002, msg: 'Bot not in chat' });
    await expect(
      service.notifyDemandSaved(demand, 'CREATED'),
    ).resolves.toBeUndefined();
    expect((service as any).logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('code=230002'),
    );
    expect((service as any).logger.log).not.toHaveBeenCalled();
  });

  it('bắt exception từ SDK, cấu hình hoặc card builder mà không throw', async () => {
    createMessage.mockRejectedValue(new Error('network unavailable'));
    await expect(
      service.notifyDemandSaved(demand, 'UPDATED'),
    ).resolves.toBeUndefined();
    expect((service as any).logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('network unavailable'),
    );

    config.get.mockImplementationOnce(() => {
      throw new Error('config unavailable');
    });
    await expect(
      service.notifyDemandSaved(demand, 'UPDATED'),
    ).resolves.toBeUndefined();

    createMessage.mockClear();
    jest.spyOn(service as any, 'buildCard').mockImplementationOnce(() => {
      throw new Error('invalid card');
    });
    await expect(
      service.notifyDemandSaved(demand, 'UPDATED'),
    ).resolves.toBeUndefined();
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('fire-and-forget không chờ request Lark hoàn tất và bắt lỗi bất đồng bộ', async () => {
    let rejectMessage!: (error: Error) => void;
    createMessage.mockReturnValue(
      new Promise((_, reject) => {
        rejectMessage = reject;
      }),
    );

    expect(service.notifyDemandSavedAsync(demand, 'CREATED')).toBeUndefined();
    expect(createMessage).toHaveBeenCalledTimes(1);
    rejectMessage(new Error('Lark timeout'));
    await new Promise((resolve) => setImmediate(resolve));
    expect((service as any).logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Lark timeout'),
    );
  });

  it('không gửi tháng đã hủy hoặc snapshot không có tháng', async () => {
    demand.months[0].status = 'CANCELLED';
    await service.notifyDemandSaved(demand, 'UPDATED');
    demand.months = [];
    await service.notifyDemandSaved(demand, 'CREATED');
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('gom các tháng phiếu cũ vào một card, loại tháng đã hủy', async () => {
    demand.months.push(
      { ...demand.months[0], id: 11, month: '2026-11' },
      { ...demand.months[0], id: 12, month: '2026-12', status: 'CANCELLED' },
    );
    await service.notifyDemandSaved(demand, 'UPDATED');
    expect(createMessage).toHaveBeenCalledTimes(1);
    const text = sentCard()
      .elements.map((element) => element.text.content)
      .join('\n');
    expect(text).toContain('Demand Tháng 10/2026 :');
    expect(text).toContain('Demand Tháng 11/2026 :');
    expect(text).not.toContain('Demand Tháng 12/2026 :');
  });
});
