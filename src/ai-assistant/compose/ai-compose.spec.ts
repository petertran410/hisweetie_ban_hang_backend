import { LlmError } from '../llm/openai-chat-client';
import { AiComposeService, type ComposeActor } from './ai-compose.service';
import { matchProducts, parseJsonReply } from './product-matcher';

const PRODUCTS = [
  {
    id: 1,
    code: 'MX01',
    name: 'Mứt xoài Lermao 1kg',
    unit: 'Hộp',
    basePrice: 150000,
  },
  {
    id: 2,
    code: 'MX02',
    name: 'Mứt xoài nhiệt đới thùng 12 hộp',
    unit: 'Thùng',
    basePrice: 1700000,
  },
  {
    id: 3,
    code: 'TL01',
    name: 'Trà lài Phượng Hoàng 500g',
    unit: 'Gói',
    basePrice: 90000,
  },
  {
    id: 4,
    code: 'SR01',
    name: 'Siro đào 750ml',
    unit: 'Chai',
    basePrice: 120000,
  },
];

describe('matchProducts', () => {
  it('khớp tên không dấu, ưu tiên hàng khách đã mua', () => {
    expect(matchProducts('mut xoai', PRODUCTS).map((p) => p.id)).toEqual([
      1, 2,
    ]);
    const bought = new Map([[2, 3]]);
    expect(matchProducts('lấy chị mứt xoài', PRODUCTS, bought)[0].id).toBe(2);
  });
  it('từ cuối gõ dở khớp đầu từ ("siro đ" → Siro đào)', () => {
    expect(matchProducts('siro đ', PRODUCTS)[0].id).toBe(4);
  });
  it('mã sản phẩm gõ đúng đứng đầu; không khớp thì rỗng', () => {
    expect(matchProducts('TL01', PRODUCTS)[0].id).toBe(3);
    expect(matchProducts('bánh tráng', PRODUCTS)).toEqual([]);
  });
  it('parseJsonReply bỏ lời dẫn / ```json', () => {
    expect(
      parseJsonReply<{ a: number }>('Đây:\n```json\n{"a":1}\n```'),
    ).toEqual({ a: 1 });
    expect(parseJsonReply('không có json')).toBeNull();
  });
});

describe('AiComposeService', () => {
  const actor = (perms: string[]): ComposeActor => ({
    id: 9,
    name: 'Sale B',
    canViewOtherStaffData: false,
    branchId: 1,
    can: (p) => perms.includes(p),
  });

  const make = (reply: string | Error) => {
    const complete = jest.fn(async () => {
      if (reply instanceof Error) throw reply;
      return {
        content: reply,
        toolCalls: [],
        finishReason: 'stop',
        usage: null,
        model: 'm1',
      };
    });
    const audit = { create: jest.fn().mockResolvedValue(null) };
    const prisma = {
      auditLog: { count: jest.fn().mockResolvedValue(0) },
      product: { findMany: jest.fn().mockResolvedValue(PRODUCTS) },
      invoiceDetail: {
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest
          .fn()
          .mockResolvedValue([{ productId: 2, _count: { _all: 4 } }]),
      },
      chatQuickReply: {
        findMany: jest.fn().mockResolvedValue([
          { id: 5, shortcut: 'stk', content: 'Số tài khoản…' },
          { id: 6, shortcut: 'giao', content: 'Đơn giao trong 1-2 ngày' },
        ]),
      },
      inventory: { findMany: jest.fn().mockResolvedValue([]) },
      aiThreadLabel: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({}),
      },
      order: {
        findFirst: jest.fn().mockResolvedValue({
          code: 'DH1',
          priceBookId: 7,
          createdAt: new Date('2026-11-20'),
        }),
      },
      invoice: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const BG_SI = {
      id: 7,
      name: 'BG sỉ',
      forAllCustomer: true,
      forAllCusGroup: true,
      priceBookCustomers: [],
      priceBookCustomerGroups: [],
      priceBookDetails: [{ productId: 2, isActive: true, price: 1600000 }],
    };
    const BG_CHUOI = {
      ...BG_SI,
      id: 9,
      name: 'BG chuỗi khác',
      priceBookDetails: [{ productId: 2, isActive: true, price: 900000 }],
    };
    const priceBooks = {
      // anyCustomer: mọi bảng giá chọn được; có khách: bảng giá khách dùng được (ở đây đều mở)
      getApplicablePriceBooks: jest.fn().mockResolvedValue([BG_CHUOI, BG_SI]),
    };
    const smax = {
      getThreadMessages: jest.fn().mockResolvedValue({
        thread: null,
        messages: [
          {
            id: 'm1',
            text: 'lấy chị 2 thùng mứt xoài, sđt 0912345678',
            type: 'message',
            fromMe: false,
            senderName: 'Chị Huệ',
            attachments: [],
            stickerId: null,
            stickerImage: null,
            quote: null,
            recalled: false,
            createdAt: '2026-11-22T02:00:00Z',
          },
        ],
        hasMore: false,
      }),
      myChannels: jest
        .fn()
        .mockResolvedValue([
          { pagePid: 'zlwA', name: 'Diệp Trà - Ms Mai Phương' },
        ]),
      getContext: jest.fn().mockResolvedValue({
        customer: { id: 3, code: 'KH1', name: 'Chị Huệ' },
        salePic: null,
        debt: null,
        recentOrders: [],
        recentInvoices: [],
      }),
    };
    const chat = {
      ready: true,
      llm: { complete },
      config: { assistantModels: ['m1', 'm2'] },
    };
    const service = new AiComposeService(
      prisma as any,
      audit as any,
      priceBooks as any,
      smax as any,
      chat as any,
    );
    return { service, complete, audit, smax, prisma, priceBooks, BG_SI };
  };

  it('xác nhận đơn: giá lấy từ bảng giá khách, không từ model; SĐT bị che trong prompt', async () => {
    const { service, complete, audit } = make(
      '{"items":[{"text":"mứt xoài","code":null,"quantity":2,"unit":"thùng","price":1}],"delivery":{"date":"thứ 4","address":null,"receiver":null}}',
    );
    const result = (await service.run(actor(['products:view_sale_price']), {
      mode: 'order',
      pagePid: 'zlwA',
      tid: 'zlw1',
      customerId: 3,
    })) as any;
    expect(result.lines[0]).toEqual(
      expect.objectContaining({ quantity: 2, unit: 'thùng' }),
    );
    // Khách từng mua MX02 → đứng đầu, giá theo bảng giá khách
    expect(result.lines[0].candidates[0]).toEqual(
      expect.objectContaining({
        code: 'MX02',
        price: 1600000,
        priceBookName: 'BG sỉ',
        bought: true,
      }),
    );
    expect(result.delivery.date).toBe('thứ 4');
    const prompt = JSON.stringify((complete.mock.calls as unknown[][])[0][0]);
    expect(prompt).not.toContain('0912345678');
    expect(audit.create).toHaveBeenCalledWith(
      expect.objectContaining({ actionCode: 'AI_COMPOSE' }),
    );
  });

  it('một bảng giá cho cả đơn: bảng giá đơn gần nhất, không lấy bảng giá mở khác', async () => {
    const { service } = make(
      '{"items":[{"text":"mứt xoài","quantity":1},{"text":"siro đào","quantity":2}]}',
    );
    const result = (await service.run(actor(['products:view_sale_price']), {
      mode: 'order',
      pagePid: 'zlwA',
      tid: 'zlw1',
      customerId: 3,
    })) as any;
    expect(result.priceBook).toEqual({
      id: 7,
      name: 'BG sỉ',
      source: 'bảng giá của DH1 gần nhất',
    });
    // MX02 có trong BG sỉ (không phải 900.000 của bảng giá chuỗi khác)
    expect(result.lines[0].candidates[0]).toEqual(
      expect.objectContaining({ code: 'MX02', price: 1600000, inBook: true }),
    );
    // Siro đào không có trong BG sỉ → giá gốc, inBook false
    expect(result.lines[1].candidates[0]).toEqual(
      expect.objectContaining({ code: 'SR01', price: 120000, inBook: false }),
    );
  });

  it('khách từng mua → giá hoá đơn gần nhất (thành tiền / SL, quy thùng về đơn vị gốc)', async () => {
    const { service, prisma } = make(
      '{"items":[{"text":"mứt xoài","quantity":1},{"text":"siro đào","quantity":1}]}',
    );
    prisma.invoiceDetail.findMany.mockResolvedValue([
      // mới nhất trước: MX02 bán 1.550.000 sau giảm giá dòng
      {
        productId: 2,
        quantity: 2,
        totalPrice: 3100000,
        quantityUnit: 'base',
        conversionValueSnapshot: 1,
        invoice: {
          code: 'HD9',
          purchaseDate: new Date('2026-11-17T03:00:00Z'),
        },
      },
      {
        productId: 2,
        quantity: 1,
        totalPrice: 1700000,
        quantityUnit: 'base',
        conversionValueSnapshot: 1,
        invoice: {
          code: 'HD1',
          purchaseDate: new Date('2026-10-01T03:00:00Z'),
        },
      },
      // SR01 bán theo thùng 12 chai: 1.320.000 / thùng → 110.000 / chai
      {
        productId: 4,
        quantity: 1,
        totalPrice: 1320000,
        quantityUnit: 'carton',
        conversionValueSnapshot: 12,
        invoice: {
          code: 'HD8',
          purchaseDate: new Date('2026-11-10T03:00:00Z'),
        },
      },
    ]);
    const result = (await service.run(actor(['products:view_sale_price']), {
      mode: 'order',
      pagePid: 'zlwA',
      tid: 'zlw1',
      customerId: 3,
    })) as any;
    expect(result.lines[0].candidates[0]).toEqual(
      expect.objectContaining({
        code: 'MX02',
        price: 1550000,
        lastInvoice: { code: 'HD9', date: '17/11/2026' },
      }),
    );
    expect(result.lines[1].candidates[0]).toEqual(
      expect.objectContaining({
        code: 'SR01',
        price: 110000,
        lastInvoice: { code: 'HD8', date: '10/11/2026' },
      }),
    );
    // Hoá đơn huỷ / hàng tặng bị loại ngay trong truy vấn
    expect(prisma.invoiceDetail.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isGift: false,
          invoice: expect.objectContaining({
            customerId: 3,
            status: { not: 2 },
          }),
        }),
      }),
    );
  });

  it('bảng giá riêng của khách thắng bảng giá đơn gần nhất', async () => {
    const { service, priceBooks, BG_SI } = make(
      '{"items":[{"text":"mứt xoài","quantity":1}]}',
    );
    const own = {
      ...BG_SI,
      id: 11,
      name: 'BG riêng',
      forAllCustomer: false,
      priceBookCustomers: [{ customerId: 3 }],
      priceBookDetails: [{ productId: 2, isActive: true, price: 1500000 }],
    };
    priceBooks.getApplicablePriceBooks.mockImplementation(
      async (q: { customerId?: number }) =>
        q.customerId ? [own] : [BG_SI, own],
    );
    const result = (await service.run(actor(['products:view_sale_price']), {
      mode: 'order',
      pagePid: 'zlwA',
      tid: 'zlw1',
      customerId: 3,
    })) as any;
    expect(result.priceBook.name).toBe('BG riêng');
    expect(result.lines[0].candidates[0].price).toBe(1500000);
  });

  it('không có quyền xem giá → price null', async () => {
    const { service } = make('{"items":[{"text":"mứt xoài","quantity":1}]}');
    const result = (await service.run(actor([]), {
      mode: 'order',
      pagePid: 'zlwA',
      tid: 'zlw1',
      customerId: 3,
    })) as any;
    expect(result.priceVisible).toBe(false);
    expect(result.lines[0].candidates[0].price).toBeNull();
  });

  it('tin nhắn nhanh: chỉ giữ id có thật; model lỗi thì sang model kế', async () => {
    const { service, complete } = make('{"ids":[6, 99, 5]}');
    complete.mockRejectedValueOnce(new LlmError('overloaded', 529));
    const result = await service.run(actor([]), {
      mode: 'quick',
      pagePid: 'zlwA',
      tid: 'zlw1',
    });
    expect(result).toEqual({ ids: [6, 5] });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('viết lại cần nội dung; hết lượt trong ngày → 429', async () => {
    const { service, prisma } = make('{"drafts":["Dạ"]}');
    await expect(
      service.run(actor([]), {
        mode: 'rewrite',
        pagePid: 'zlwA',
        tid: 'zlw1',
        draft: ' ',
      }),
    ).rejects.toThrow('Gõ nội dung');
    prisma.auditLog.count.mockResolvedValue(10_000);
    await expect(
      service.run(actor([]), { mode: 'reply', pagePid: 'zlwA', tid: 'zlw1' }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('tóm tắt: trỏ đúng tin theo số, bỏ số không có thật; số trang theo tin chưa đọc', async () => {
    const { service, smax } = make(
      '{"overview":"Khách đặt mứt xoài","unanswered":[{"ref":1,"who":"Chị Huệ","text":"Lấy 2 thùng mứt xoài"},{"ref":99,"text":"bịa"}],"needs":[{"who":"Chị Huệ","need":"2 thùng mứt xoài"}],"todo":["Xác nhận đơn"]}',
    );
    const result = (await service.run(actor([]), {
      mode: 'summary',
      pagePid: 'zlwA',
      tid: 'zlw1',
      unreadCount: 5,
    })) as any;
    expect(smax.getThreadMessages).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      count: 1,
      overview: 'Khách đặt mứt xoài',
      unanswered: [
        {
          messageId: 'm1',
          time: '2026-11-22T02:00:00Z',
          who: 'Chị Huệ',
          text: 'Lấy 2 thùng mứt xoài',
        },
      ],
      needs: [{ who: 'Chị Huệ', need: '2 thùng mứt xoài' }],
      todo: ['Xác nhận đơn'],
    });
  });

  it('phân loại: lưu nhãn theo số hội thoại, "other" không chờ xử lý, bỏ nhãn lạ; giữ nhãn gắn tay', async () => {
    const { service, prisma } = make(
      '{"items":[{"n":1,"label":"order","pending":true,"reason":"Khách đặt mứt xoài"},{"n":2,"label":"other","pending":true},{"n":3,"label":"lạ"}]}',
    );
    prisma.aiThreadLabel.findMany.mockResolvedValue([
      // zlw3 đã gắn tay, chưa có tin mới → không phân loại lại
      { tid: 'zlw3', lastMessageAt: new Date('2026-11-22T02:00:00Z') },
    ]);
    const result = await service.run(actor([]), {
      mode: 'classify',
      pagePid: 'zlwA',
      tid: 'zlw1',
      tids: ['zlw1', 'zlw2', 'zlw3'],
    });
    expect(result).toEqual({ labeled: 2 });
    const calls = (prisma.aiThreadLabel.upsert.mock.calls as any[][]).map(
      (c) => c[0],
    );
    expect(
      calls.map((c) => [
        c.where.pagePid_tid.tid,
        c.create.label,
        c.create.pending,
      ]),
    ).toEqual([
      ['zlw1', 'order', true],
      ['zlw2', 'other', false],
    ]);
  });

  it('khách mới: chỉ nhận phân loại hợp lệ, ô không "high" là chưa chắc', async () => {
    const { service } = make(
      '{"name":"Trà sữa Na","category":"quán lẻ","province":"Hồ Chí Minh","ward":null,"need":"Hỏi giá trân châu","confidence":{"name":"high","province":"high","need":"high"}}',
    );
    const result = await service.run(actor([]), {
      mode: 'lead',
      pagePid: 'zlwA',
      tid: 'zlw1',
    });
    expect(result).toEqual({
      name: 'Trà sữa Na',
      category: null,
      province: 'Hồ Chí Minh',
      ward: null,
      need: 'Hỏi giá trân châu',
      unsure: ['category', 'ward'],
    });
  });

  it('đọc ảnh chuyển khoản: chỉ ảnh thuộc tin, chỉ Claude, khớp SePay khi có quyền', async () => {
    const { service, smax, prisma, complete } = make(
      '{"kind":"transfer","summary":"CK 3.216.000","transfer":{"amount":3216000,"content":"KH001928 CK DON","bank":"VCB","time":"2026-11-22 09:10","reference":"FT123"}}',
    );
    (service as any).chat.config.assistantModels = [
      'm-cheap',
      'claude-sonnet-5-5',
    ];
    const msg = (await smax.getThreadMessages()).messages[0];
    smax.getThreadMessages.mockResolvedValue({
      thread: null,
      messages: [
        {
          ...msg,
          id: 'img1',
          attachments: [
            {
              url: 'https://zalo/img.jpg',
              thumbnail: null,
              title: '',
              type: 'image',
            },
          ],
        },
      ],
      hasMore: false,
    });
    (smax as any).fetchZaloMedia = jest.fn().mockResolvedValue({
      body: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]), // JPEG
      contentType: 'application/octet-stream', // Zalo hay trả kiểu chung
    });
    (prisma as any).sepayTransaction = {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 5,
          transactionDate: new Date('2026-11-22T02:11:00Z'),
          amountIn: 3216000,
          transactionContent: 'KH001928 CK DON',
          referenceNumber: 'FT123',
          bankBrandName: 'VCB',
        },
        {
          id: 6,
          transactionDate: new Date('2026-11-22T03:00:00Z'),
          amountIn: 3216000,
          transactionContent: 'khac',
          referenceNumber: 'X',
          bankBrandName: 'MB',
        },
      ]),
    };
    (prisma as any).sepayAllocation = {
      findMany: jest.fn().mockResolvedValue([{ sepayTransactionId: 6 }]),
    };

    const result = (await service.run(actor(['sepay:view']), {
      mode: 'image',
      pagePid: 'zlwA',
      tid: 'zlw1',
      messageId: 'img1',
      imageUrl: 'https://zalo/img.jpg',
    })) as any;
    expect((complete.mock.calls as any[][])[0][0].model).toBe(
      'claude-sonnet-5-5',
    );
    expect(
      (complete.mock.calls as any[][])[0][0].messages[1].images[0].mediaType,
    ).toBe('image/jpeg');
    expect(result.transfer.amount).toBe(3216000);
    expect(result.sepay.map((t: any) => t.id)).toEqual([5]); // giao dịch đã phân bổ bị loại
    expect(
      (prisma as any).sepayTransaction.findMany.mock.calls[0][0].where,
    ).toMatchObject({ amountIn: 3216000, confirmedAt: null, hiddenAt: null });

    const noPerm = (await service.run(actor([]), {
      mode: 'image',
      pagePid: 'zlwA',
      tid: 'zlw1',
      messageId: 'img1',
      imageUrl: 'https://zalo/img.jpg',
    })) as any;
    expect(noPerm.sepay).toBeNull();

    await expect(
      service.run(actor([]), {
        mode: 'image',
        pagePid: 'zlwA',
        tid: 'zlw1',
        messageId: 'img1',
        imageUrl: 'https://evil/x.jpg',
      }),
    ).rejects.toThrow('Không tìm thấy ảnh');
  });

  it('gợi ý trả lời trả tối đa 3 bản nháp', async () => {
    const { service } = make('{"drafts":["a","b","c","d"]}');
    const result = await service.run(actor([]), {
      mode: 'reply',
      pagePid: 'zlwA',
      tid: 'zlw1',
    });
    expect(result).toEqual({ drafts: ['a', 'b', 'c'] });
  });
});
