import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, QuoteTemplate } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QuoteTemplatePayloadDto } from './dto/quote.dto';
import { validateTiers } from './quote-pricing';

type Row = QuoteTemplate & { updatedBy: { id: number; name: string } | null };

const UPDATER = {
  updatedBy: { select: { id: true, name: true } },
} satisfies Prisma.QuoteTemplateInclude;

const intro = (who: string) =>
  `Lời đầu tiên, Công ty TNHH XNK Hi Sweetie Việt Nam xin trân trọng cảm ơn ${who} đã quan tâm tới sản phẩm của Công ty chúng tôi. Chúng tôi xin trân trọng gửi tới ${who.toLowerCase()} báo giá và chính sách của các sản phẩm LerMao như sau:`;
const CLOSING =
  'Chúng tôi cam kết tiếp tục duy trì chất lượng sản phẩm ổn định, tối ưu giải pháp nguyên liệu và đồng hành cùng Quý Khách hàng trong hoạt động kinh doanh lâu dài.\nKính chúc Quý Khách hàng sức khỏe, kinh doanh thuận lợi và thành công.';
/** Đầu trang mặc định như file báo giá tổng hợp. */
export const DEFAULT_QUOTE_HEADER = {
  companyName: 'CÔNG TY TNHH XUẤT NHẬP KHẨU\nHI SWEETIE VIỆT NAM',
  department: 'PHÒNG KINH DOANH',
};
const tier = (
  key: string,
  label: string,
  minQty: number | null = null,
  maxQty: number | null = null,
) => ({
  key,
  label,
  minQty,
  maxQty,
  unit: 'thùng',
});

type TemplateSeed = Omit<Prisma.QuoteTemplateCreateInput, 'updatedBy'>;

/** 3 bộ khung giá + nội dung theo file "Bảng báo giá tổng hợp 01.09.26". */
const BASE_TEMPLATES: Omit<TemplateSeed, 'isDefault'>[] = [
  {
    name: 'Khách lẻ',
    tiers: [tier('le', 'Giá lẻ')],
    titlePattern: 'BẢNG BÁO GIÁ LẺ {MIEN} LERMAO',
    greeting: 'Quý khách hàng',
    intro: intro('Quý khách hàng'),
    closing: CLOSING,
    showMargin: false,
  },
  {
    name: 'Khách chuỗi',
    tiers: [tier('chuoi', 'Giá chuỗi', 1, null)],
    titlePattern: 'BẢNG BÁO GIÁ CHUỖI {MIEN} LERMAO',
    greeting: 'Quý chuỗi',
    intro: intro('Quý chuỗi'),
    closing: CLOSING,
    showMargin: false,
  },
  {
    name: 'Đại lý',
    tiers: [
      tier('le', 'Giá lẻ'),
      tier('ctv', 'Giá CTV'),
      tier('dl_lt10', 'Giá Đại lý < 10T', 1, 9),
      tier('dl_ge10', 'Giá Đại lý ≥ 10T', 10, null),
    ],
    titlePattern: 'BẢNG BÁO GIÁ ĐẠI LÝ {MIEN} LERMAO',
    greeting: 'Quý Đại lý',
    intro: intro('Quý đại lý'),
    closing: CLOSING,
    showMargin: true,
  },
];

/** 6 mẫu mặc định — mỗi bộ khung giá × 2 kiểu trình bày; "Khách lẻ · Mẫu 1" là mặc định. Dùng cho seed. */
export const DEFAULT_QUOTE_TEMPLATES: TemplateSeed[] = BASE_TEMPLATES.flatMap(
  (t, i) => [
    {
      ...t,
      ...DEFAULT_QUOTE_HEADER,
      name: `${t.name} · Mẫu 1 Bảng giá`,
      layout: 'classic',
      isDefault: i === 0,
    },
    {
      ...t,
      ...DEFAULT_QUOTE_HEADER,
      name: `${t.name} · Mẫu 2 LerMao`,
      layout: 'brand',
      isDefault: false,
    },
  ],
);

@Injectable()
export class QuoteTemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const rows = await this.prisma.quoteTemplate.findMany({
      include: UPDATER,
      orderBy: [{ isDefault: 'desc' }, { id: 'asc' }],
    });
    return rows.map((r) => this.toConfig(r));
  }

  async create(dto: QuoteTemplatePayloadDto, userId: number) {
    this.validate(dto);
    const hasDefault = await this.prisma.quoteTemplate.count({
      where: { isDefault: true },
    });
    const row = await this.prisma.quoteTemplate.create({
      data: { ...this.data(dto), isDefault: !hasDefault, updatedById: userId },
      include: UPDATER,
    });
    return this.toConfig(row);
  }

  async update(id: number, dto: QuoteTemplatePayloadDto, userId: number) {
    this.validate(dto);
    await this.find(id);
    const row = await this.prisma.quoteTemplate.update({
      where: { id },
      data: { ...this.data(dto), updatedById: userId },
      include: UPDATER,
    });
    return this.toConfig(row);
  }

  /** Mẫu chọn sẵn khi tạo báo giá — đúng 1 mẫu mặc định. */
  async setDefault(id: number, userId: number) {
    const t = await this.find(id);
    if (!t.isActive)
      throw new BadRequestException(
        'Mẫu đang ngừng sử dụng — dùng lại trước khi đặt mặc định',
      );
    await this.prisma.$transaction([
      this.prisma.quoteTemplate.updateMany({
        where: { isDefault: true },
        data: { isDefault: false },
      }),
      this.prisma.quoteTemplate.update({
        where: { id },
        data: { isDefault: true, updatedById: userId },
      }),
    ]);
    return this.toConfig(await this.find(id));
  }

  /** Ngừng sử dụng / dùng lại (không xoá mẫu). */
  async setActive(id: number, isActive: boolean, userId: number) {
    const t = await this.find(id);
    if (!isActive && t.isDefault)
      throw new BadRequestException(
        'Không ngừng sử dụng được mẫu mặc định — đặt mẫu khác làm mặc định trước',
      );
    const row = await this.prisma.quoteTemplate.update({
      where: { id },
      data: { isActive, updatedById: userId },
      include: UPDATER,
    });
    return this.toConfig(row);
  }

  private async find(id: number): Promise<Row> {
    const t = await this.prisma.quoteTemplate.findUnique({
      where: { id },
      include: UPDATER,
    });
    if (!t) throw new NotFoundException('Không tìm thấy mẫu báo giá');
    return t;
  }

  private validate(dto: QuoteTemplatePayloadDto) {
    const err = validateTiers(dto.tiers);
    if (err) throw new BadRequestException(err);
  }

  private data(dto: QuoteTemplatePayloadDto) {
    return {
      name: dto.name.trim(),
      layout: dto.layout,
      logoUrl: dto.logoUrl ?? null,
      companyName: dto.companyName.trim(),
      department: dto.department.trim(),
      tiers: dto.tiers.map((t) => ({
        key: t.key,
        label: t.label.trim(),
        minQty: t.minQty ?? null,
        maxQty: t.maxQty ?? null,
        unit: t.unit,
      })),
      titlePattern: dto.titlePattern.trim(),
      greeting: dto.greeting,
      intro: dto.intro,
      note: dto.note,
      closing: dto.closing,
      showMargin: dto.showMargin,
    };
  }

  /** Hàng DB → QuoteTemplateConfig của frontend. */
  private toConfig(r: Row) {
    return {
      id: r.id,
      name: r.name,
      layout: r.layout,
      logoUrl: r.logoUrl,
      companyName: r.companyName,
      department: r.department,
      isDefault: r.isDefault,
      isActive: r.isActive,
      tiers: r.tiers,
      titlePattern: r.titlePattern,
      greeting: r.greeting,
      intro: r.intro,
      note: r.note,
      closing: r.closing,
      showMargin: r.showMargin,
      updatedAt: r.updatedAt.toISOString(),
      updatedBy: r.updatedBy ?? { id: 0, name: 'Hệ thống' },
    };
  }
}
