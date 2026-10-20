const DIGITS = [
  'không',
  'một',
  'hai',
  'ba',
  'bốn',
  'năm',
  'sáu',
  'bảy',
  'tám',
  'chín',
];

// Nhóm 3 chữ số: nhóm đứng sau nhóm khác 0 phải đọc đủ ("không trăm", "linh").
function readGroup(value: number, full: boolean): string {
  const hundred = Math.floor(value / 100);
  const ten = Math.floor(value / 10) % 10;
  const unit = value % 10;
  const words: string[] = [];
  if (hundred > 0 || full) words.push(`${DIGITS[hundred]} trăm`);
  if (ten === 0) {
    if (unit > 0)
      words.push(words.length ? `linh ${DIGITS[unit]}` : DIGITS[unit]);
  } else if (ten === 1) {
    words.push('mười');
    if (unit === 5) words.push('lăm');
    else if (unit > 0) words.push(DIGITS[unit]);
  } else {
    words.push(`${DIGITS[ten]} mươi`);
    if (unit === 1) words.push('mốt');
    else if (unit === 5) words.push('lăm');
    else if (unit > 0) words.push(DIGITS[unit]);
  }
  return words.join(' ');
}

// Đơn vị của nhóm thứ i (tính từ phải): "", nghìn, triệu, tỷ, nghìn tỷ, ...
function groupUnit(index: number): string {
  const base = ['', 'nghìn', 'triệu'][index % 3];
  const billions = Array.from({ length: Math.floor(index / 3) }, () => 'tỷ');
  return [base, ...billions].filter(Boolean).join(' ');
}

/** Đọc số tiền bằng chữ tiếng Việt, vd 1.005.000 → "Một triệu không trăm linh năm nghìn đồng". */
export function vnNumberToWords(value: number): string {
  const amount = Math.floor(Math.abs(Number(value) || 0));
  if (amount === 0) return 'Không đồng';
  const groups: number[] = [];
  for (let rest = amount; rest > 0; rest = Math.floor(rest / 1000))
    groups.push(rest % 1000);
  const parts: string[] = [];
  let started = false;
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index];
    if (group === 0) continue;
    parts.push(readGroup(group, started), groupUnit(index));
    started = true;
  }
  const words = `${value < 0 ? 'âm ' : ''}${parts.filter(Boolean).join(' ')} đồng`;
  return words.charAt(0).toUpperCase() + words.slice(1);
}
