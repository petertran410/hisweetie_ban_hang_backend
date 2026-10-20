import { vnNumberToWords } from './vn-number-words';

describe('vnNumberToWords', () => {
  it.each([
    [0, 'Không đồng'],
    [5, 'Năm đồng'],
    [10, 'Mười đồng'],
    [15, 'Mười lăm đồng'],
    [21, 'Hai mươi mốt đồng'],
    [25, 'Hai mươi lăm đồng'],
    [105, 'Một trăm linh năm đồng'],
    [110, 'Một trăm mười đồng'],
    [1_005_000, 'Một triệu không trăm linh năm nghìn đồng'],
    [1_000_005, 'Một triệu không trăm linh năm đồng'],
    [2_050_000, 'Hai triệu không trăm năm mươi nghìn đồng'],
    [15_500_000, 'Mười lăm triệu năm trăm nghìn đồng'],
    [50_000_000, 'Năm mươi triệu đồng'],
    [2_500_000_000, 'Hai tỷ năm trăm triệu đồng'],
    [1_000_000_000_000, 'Một nghìn tỷ đồng'],
  ])('%d → %s', (value, expected) => {
    expect(vnNumberToWords(value)).toBe(expected);
  });

  it('bỏ phần lẻ và đọc số âm', () => {
    expect(vnNumberToWords(1500.75)).toBe('Một nghìn năm trăm đồng');
    expect(vnNumberToWords(-21)).toBe('Âm hai mươi mốt đồng');
  });
});
