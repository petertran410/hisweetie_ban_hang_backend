import {
  completeBlockReason,
  computeStatus,
  missingRequired,
  nextStage,
  resolveAccess,
  RuleActor,
  RuleTicket,
} from './new-product-price.rules';

const proposalReady: RuleTicket = {
  stage: 'PROPOSAL',
  productName: 'Siro Đào',
  parentName: 'Hàng thương hiệu',
  childName: 'Siro',
  tradeMarkId: 3,
  unit: 'Chai',
  netWeightGram: 750,
  createdById: 10,
};

const user = (id: number, extra: Partial<RuleActor> = {}): RuleActor => ({
  id,
  isSuperAdmin: false,
  permissions: ['new_product_price:view'],
  ...extra,
});

const approvers = {
  PURCHASING: [20],
  ACCOUNTING: [30],
  CHIEF_ACCOUNTANT: [31],
  SALES: [40],
  CEO: [50],
  DATA: [60],
};

describe('computeStatus (công thức Trạng thái trên Lark)', () => {
  it('mặc định là Đang duyệt', () => {
    expect(computeStatus({ stage: 'PURCHASING' })).toBe('UNDER_REVIEW');
  });

  it('KTT hoặc CEO từ chối → Từ chối', () => {
    expect(
      computeStatus({
        stage: 'ACCOUNTING',
        chiefAccountantDecision: 'REJECTED',
      }),
    ).toBe('REJECTED');
    expect(computeStatus({ stage: 'CEO', ceoDecision: 'REJECTED' })).toBe(
      'REJECTED',
    );
  });

  it('CEO duyệt → Đã duyệt', () => {
    expect(computeStatus({ stage: 'DATA', ceoDecision: 'APPROVED' })).toBe(
      'APPROVED',
    );
  });

  it('Hàng sản xuất từ bước Kinh Doanh trở đi tự Đã duyệt', () => {
    const t = { parentName: 'hàng  sản xuất', ceoDecision: null };
    expect(computeStatus({ ...t, stage: 'ACCOUNTING' })).toBe('UNDER_REVIEW');
    expect(computeStatus({ ...t, stage: 'SALES' })).toBe('APPROVED');
    expect(computeStatus({ ...t, stage: 'DATA' })).toBe('APPROVED');
  });
});

describe('nextStage', () => {
  it('đi đúng thứ tự các bước', () => {
    expect(nextStage({ stage: 'PROPOSAL' })).toBe('PURCHASING');
    expect(nextStage({ stage: 'PURCHASING' })).toBe('ACCOUNTING');
    expect(nextStage({ stage: 'ACCOUNTING' })).toBe('SALES');
    expect(nextStage({ stage: 'SALES' })).toBe('CEO');
    expect(nextStage({ stage: 'CEO' })).toBe('DATA');
    expect(nextStage({ stage: 'DATA' })).toBe('DONE');
    expect(nextStage({ stage: 'DONE' })).toBeNull();
  });

  it('Hàng sản xuất bỏ qua CEO', () => {
    expect(nextStage({ stage: 'SALES', parentName: 'Hàng sản xuất' })).toBe(
      'DATA',
    );
  });
});

describe('trường bắt buộc', () => {
  it('Đề xuất đủ trường thì không thiếu gì', () => {
    expect(missingRequired(proposalReady, 'PROPOSAL')).toEqual([]);
    expect(completeBlockReason(proposalReady)).toBeNull();
  });

  it('báo đúng trường còn thiếu (chuỗi rỗng coi như thiếu)', () => {
    const t = { ...proposalReady, unit: '  ', tradeMarkId: null };
    expect(missingRequired(t, 'PROPOSAL')).toEqual(['tradeMarkId', 'unit']);
    expect(completeBlockReason(t)).toBe('Còn thiếu: Thương hiệu, Đơn vị tính');
  });

  it('Thu Mua chỉ bắt buộc quy cách, nguồn gốc, giá hàng (NCC/nhà máy, ngày về, tỉ giá, cost không bắt buộc)', () => {
    expect(missingRequired({ stage: 'PURCHASING' }, 'PURCHASING')).toEqual([
      'packingSpec',
      'middleName',
      'goodsPrice',
    ]);
  });

  it('Kế Toán đã gửi KTT thì phải chờ KTT duyệt', () => {
    const t: RuleTicket = {
      stage: 'ACCOUNTING',
      cogsHn: 1,
      cogsSg: 1,
      cogsDt: 1,
      sendToChiefAccountant: true,
      chiefAccountantDecision: null,
    };
    expect(completeBlockReason(t)).toBe(
      'Đang chờ Kế toán trưởng duyệt giá vốn',
    );
    expect(
      completeBlockReason({ ...t, chiefAccountantDecision: 'APPROVED' }),
    ).toBeNull();
  });

  it('Kinh Doanh không có trường bắt buộc', () => {
    expect(missingRequired({ stage: 'SALES' }, 'SALES')).toEqual([]);
  });
});

describe('resolveAccess', () => {
  it('người tạo hoàn tất bước Đề xuất, người khác thì không', () => {
    const own = resolveAccess(proposalReady, user(10), approvers);
    expect(own.actions).toContain('COMPLETE');
    expect(own.editableFields).toEqual(
      expect.arrayContaining(['productName', 'unit', 'note']),
    );
    const other = resolveAccess(proposalReady, user(99), approvers);
    expect(other.actions).toEqual(['COMMENT']);
    expect(other.editableFields).toEqual([]);
  });

  it('bước Thu Mua: nhóm Thu Mua hoặc người duyệt giá cost', () => {
    const t = { ...proposalReady, stage: 'PURCHASING', costApproverId: 21 };
    expect(resolveAccess(t, user(20), approvers).actions).toContain('COMPLETE');
    expect(resolveAccess(t, user(21), approvers).actions).toContain('COMPLETE');
    expect(resolveAccess(t, user(30), approvers).actions).not.toContain(
      'COMPLETE',
    );
  });

  it('người tạo vẫn sửa Mô tả khi phiếu ở Thu Mua', () => {
    const t = { ...proposalReady, stage: 'PURCHASING' };
    const access = resolveAccess(t, user(10), approvers);
    expect(access.editableFields).toEqual(['description']);
    expect(access.actions).toContain('END');
  });

  it('Kế Toán gửi KTT; chỉ Kế toán trưởng được duyệt', () => {
    const t: RuleTicket = { stage: 'ACCOUNTING', createdById: 10 };
    expect(resolveAccess(t, user(30), approvers).actions).toContain('SEND_KTT');
    const pending = { ...t, sendToChiefAccountant: true };
    expect(resolveAccess(pending, user(30), approvers).actions).not.toContain(
      'SEND_KTT',
    );
    expect(resolveAccess(pending, user(31), approvers).actions).toContain(
      'KTT_DECIDE',
    );
    expect(resolveAccess(pending, user(30), approvers).actions).not.toContain(
      'KTT_DECIDE',
    );
  });

  it('CEO duyệt, Phòng Dữ Liệu áp dụng; đã tạo sản phẩm thì không trả về', () => {
    expect(
      resolveAccess({ stage: 'CEO' }, user(50), approvers).actions,
    ).toEqual(expect.arrayContaining(['CEO_DECIDE', 'SEND_BACK']));
    const data = resolveAccess({ stage: 'DATA' }, user(60), approvers);
    expect(data.actions).toEqual(
      expect.arrayContaining(['APPLY', 'SEND_BACK']),
    );
    expect(data.editableFields).toContain('parentName');
    const applied = resolveAccess(
      { stage: 'DATA', productId: 5 },
      user(60),
      approvers,
    );
    expect(applied.actions).not.toContain('SEND_BACK');
    expect(applied.editableFields).not.toContain('parentName');
  });

  it('Super Admin thao tác mọi bước; phiếu đã xong chỉ còn bình luận', () => {
    const admin = user(1, { isSuperAdmin: true });
    expect(resolveAccess({ stage: 'CEO' }, admin, {}).actions).toContain(
      'CEO_DECIDE',
    );
    expect(resolveAccess({ stage: 'DONE' }, admin, {}).actions).toEqual([
      'COMMENT',
    ]);
  });

  it('quyền config được kết thúc phiếu ở mọi bước mở', () => {
    const cfg = user(70, {
      permissions: ['new_product_price:view', 'new_product_price:config'],
    });
    expect(resolveAccess({ stage: 'SALES' }, cfg, approvers).actions).toContain(
      'END',
    );
  });
});
