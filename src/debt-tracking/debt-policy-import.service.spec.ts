import { DebtPolicyImportService } from './debt-policy-import.service';

/**
 * Test cho phần phân tích cột "Loại Công Nợ" — nơi dễ sai nhất khi import.
 * Các chuỗi dưới đây lấy nguyên văn từ file quản lý công nợ thực tế.
 */
describe('DebtPolicyImportService.parseDebtType', () => {
  const svc = new DebtPolicyImportService(null as any);
  const p = (s: string) => svc.parseDebtType(s);

  it('nhận diện "Không Công Nợ" — tắt cả hai chiều', () => {
    const r = p('Không Công Nợ');
    expect(r.recognized).toBe(true);
    expect(r.hasCreditLimit).toBe(false);
    expect(r.hasTermDays).toBe(false);
    expect(r.termDays).toBeNull();
  });

  it('chỉ số ngày', () => {
    const r = p('Công Nợ 5 Ngày');
    expect(r.hasTermDays).toBe(true);
    expect(r.termDays).toBe(5);
    expect(r.hasCreditLimit).toBe(false);
  });

  it('đọc đúng mọi kỳ hạn đang dùng thực tế', () => {
    const cases: Array<[string, number]> = [
      ['Công Nợ 1 Ngày', 1],
      ['Công Nợ 3 Ngày', 3],
      ['Công Nợ 7 Ngày', 7],
      ['Công Nợ 10 Ngày', 10],
      ['Công Nợ 15 Ngày', 15],
      ['Công Nợ 20 Ngày', 20],
      ['Công Nợ 30 Ngày', 30],
      ['Công Nợ 45 Ngày', 45],
      ['Công Nợ 55 Ngày', 55],
    ];
    for (const [raw, expected] of cases) {
      expect(p(raw).termDays).toBe(expected);
    }
  });

  it('chỉ hạn mức', () => {
    const r = p('Hạn Mức');
    expect(r.hasCreditLimit).toBe(true);
    expect(r.hasTermDays).toBe(false);
    expect(r.recognized).toBe(true);
  });

  it('kết hợp hạn mức + số ngày', () => {
    const r = p('Hạn Mức, Công Nợ 7 Ngày');
    expect(r.hasCreditLimit).toBe(true);
    expect(r.hasTermDays).toBe(true);
    expect(r.termDays).toBe(7);
  });

  it('bỏ qua khác biệt hoa thường và khoảng trắng thừa', () => {
    // Cả ba biến thể này đều xuất hiện trong file thật.
    expect(p('Hạn Mức, Công nợ 5 Ngày').termDays).toBe(5);
    expect(p('Hạn Mức,  Công Nợ 5 Ngày').termDays).toBe(5);
    expect(p('  công nợ 3 ngày  ').termDays).toBe(3);
    expect(p('Hạn Mức, Công nợ 7 Ngày').hasCreditLimit).toBe(true);
  });

  it('"1 Tháng 2 Lần" → tần suất, KHÔNG phải hạn ngày', () => {
    const r = p('1 Tháng 2 Lần');
    expect(r.paymentFrequency).toBe(2);
    expect(r.hasTermDays).toBe(false);
    expect(r.termDays).toBeNull();
    expect(r.recognized).toBe(true);
  });

  it('không nhận diện được giá trị lạ', () => {
    // "Chuyển Khoản Ngay" là hình thức công nợ, bị ghi nhầm vào cột Loại.
    expect(p('Chuyển Khoản Ngay').recognized).toBe(false);
    expect(p('abcxyz').recognized).toBe(false);
  });

  it('ô trống không được coi là hợp lệ', () => {
    expect(p('').recognized).toBe(false);
    expect(p('   ').recognized).toBe(false);
  });

  it('không nhầm số trong tên khác thành số ngày', () => {
    const r = p('Hạn Mức');
    expect(r.termDays).toBeNull();
    expect(r.paymentFrequency).toBeNull();
  });
});
