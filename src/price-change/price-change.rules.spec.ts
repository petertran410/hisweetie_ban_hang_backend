import {
  checkItems,
  computeStatus,
  nextStage,
  resolveAccess,
  stagePath,
  submitBlockReason,
} from './price-change.rules';

const cost = (branchId: number, newCost: number | null) => ({
  branchId,
  branchName: `CN${branchId}`,
  oldCost: 100,
  newCost,
});
const price = (priceBookId: number, newPrice: number | null) => ({
  priceBookId,
  priceBookName: `BG${priceBookId}`,
  oldPrice: 200,
  newPrice,
});

describe('price-change rules', () => {
  describe('nextStage', () => {
    it('chỉ giá bán: Kế toán trưởng → Phòng Dữ Liệu (bỏ CEO)', () => {
      expect(nextStage('PROPOSAL', false)).toBe('CHIEF_ACCOUNTANT');
      expect(nextStage('CHIEF_ACCOUNTANT', false)).toBe('DATA');
      expect(nextStage('DATA', false)).toBe('DONE');
      expect(stagePath(false)).not.toContain('CEO');
    });

    it('có giá vốn: Kế toán trưởng → CEO → Phòng Dữ Liệu', () => {
      expect(nextStage('CHIEF_ACCOUNTANT', true)).toBe('CEO');
      expect(nextStage('CEO', true)).toBe('DATA');
      expect(nextStage('DONE', true)).toBeNull();
      expect(nextStage('ENDED', true)).toBeNull();
    });
  });

  describe('computeStatus', () => {
    it('có từ chối → Rejected', () => {
      expect(
        computeStatus({ stage: 'PROPOSAL', kttDecision: 'REJECTED' }),
      ).toBe('REJECTED');
      expect(
        computeStatus({
          stage: 'PROPOSAL',
          kttDecision: 'APPROVED',
          ceoDecision: 'REJECTED',
        }),
      ).toBe('REJECTED');
    });

    it('tới Phòng Dữ Liệu / Hoàn thành → Approved, còn lại Under Review', () => {
      expect(computeStatus({ stage: 'DATA' })).toBe('APPROVED');
      expect(computeStatus({ stage: 'DONE' })).toBe('APPROVED');
      expect(computeStatus({ stage: 'CEO', kttDecision: 'APPROVED' })).toBe(
        'UNDER_REVIEW',
      );
    });
  });

  describe('checkItems', () => {
    it('suy ra hasCost / hasSale từ ô có giá mới', () => {
      const r = checkItems(
        [
          {
            productId: 1,
            productCode: 'SP1',
            costs: [cost(1, null)],
            prices: [price(0, 150)],
          },
        ],
        [1],
        [0],
      );
      expect(r).toEqual({ errors: [], hasCost: false, hasSale: true });
    });

    it('báo cột chưa chọn, giá âm, sản phẩm lặp', () => {
      const r = checkItems(
        [
          {
            productId: 1,
            productCode: 'SP1',
            costs: [cost(9, 10)],
            prices: [],
          },
          {
            productId: 1,
            productCode: 'SP1',
            costs: [],
            prices: [price(3, -1)],
          },
        ],
        [1],
        [0],
      );
      expect(r.hasCost).toBe(true);
      expect(r.errors.join('|')).toMatch(/chi nhánh "CN9" chưa được chọn/);
      expect(r.errors.join('|')).toMatch(/bị lặp/);
      expect(r.errors.join('|')).toMatch(/giá bán phải ≥ 0/);
    });
  });

  describe('submitBlockReason', () => {
    it('chặn phiếu rỗng, dòng chưa nhập giá, dòng chưa khớp sản phẩm', () => {
      expect(submitBlockReason([])).toMatch(/chưa có sản phẩm/);
      expect(
        submitBlockReason([
          {
            productId: 1,
            productCode: 'SP1',
            costs: [cost(1, null)],
            prices: [],
          },
        ]),
      ).toMatch(/SP1/);
      expect(
        submitBlockReason([
          {
            productId: null,
            productCode: 'X',
            costs: [cost(1, 5)],
            prices: [],
          },
        ]),
      ).toMatch(/chưa khớp/);
      expect(
        submitBlockReason([{ productId: 1, costs: [cost(1, 5)], prices: [] }]),
      ).toBeNull();
    });
  });

  describe('resolveAccess', () => {
    const approvers = { CHIEF_ACCOUNTANT: [2], CEO: [3], DATA: [4] };
    const actor = (id: number, permissions: string[] = []) => ({
      id,
      isSuperAdmin: false,
      permissions,
    });

    it('người tạo sửa / gửi duyệt / kết thúc ở bước Đề xuất', () => {
      const a = resolveAccess(
        { stage: 'PROPOSAL', createdById: 1 },
        actor(1),
        approvers,
      );
      expect(a.actions).toEqual(
        expect.arrayContaining(['EDIT', 'SUBMIT', 'END']),
      );
      expect(a.canEdit).toBe(true);
      expect(
        resolveAccess(
          { stage: 'PROPOSAL', createdById: 1 },
          actor(2),
          approvers,
        ).actions,
      ).toEqual(['COMMENT']);
    });

    it('mỗi nhóm chỉ thao tác ở bước của mình', () => {
      const t = { createdById: 1 };
      expect(
        resolveAccess({ ...t, stage: 'CHIEF_ACCOUNTANT' }, actor(2), approvers)
          .actions,
      ).toContain('KTT_DECIDE');
      expect(
        resolveAccess({ ...t, stage: 'CHIEF_ACCOUNTANT' }, actor(3), approvers)
          .actions,
      ).not.toContain('KTT_DECIDE');
      expect(
        resolveAccess({ ...t, stage: 'CEO' }, actor(3), approvers).actions,
      ).toContain('CEO_DECIDE');
      expect(
        resolveAccess({ ...t, stage: 'DATA' }, actor(4), approvers).actions,
      ).toEqual(expect.arrayContaining(['APPLY', 'SEND_BACK']));
      // Người tạo không tự kết thúc khi phiếu đã gửi duyệt
      expect(
        resolveAccess({ ...t, stage: 'CEO' }, actor(1), approvers).actions,
      ).not.toContain('END');
    });

    it('quyền config kết thúc được phiếu chưa xong; phiếu xong chỉ bình luận', () => {
      expect(
        resolveAccess(
          { stage: 'DATA', createdById: 1 },
          actor(9, ['price_change:config']),
          approvers,
        ).actions,
      ).toContain('END');
      expect(
        resolveAccess(
          { stage: 'DONE', createdById: 1 },
          { id: 1, isSuperAdmin: true, permissions: [] },
          approvers,
        ).actions,
      ).toEqual(['COMMENT']);
    });
  });
});
