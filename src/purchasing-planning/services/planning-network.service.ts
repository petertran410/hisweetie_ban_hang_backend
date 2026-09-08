import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CUSTOMS_LEADTIME_DAYS,
  FactoryLeadtimeConfig,
  INBOUND_LEADTIME_DAYS,
  NetworkLeadtimeConfig,
  singleLeadtimeDays,
} from '../domain/leadtime.engine';
import { UpdatePlanningNetworkConfigDto } from '../dto/planning-network-config.dto';
import { MoqSpec, normalizeMoqSpec } from '../../common/moq.util';

/** Nhà máy nguồn của một SKU kèm các thông số đặt hàng đi theo. */
export interface ProductFactoryMapping {
  factoryId: number;
  role: string;
  leadtimeDays: number | null;
  /** MOQ hiệu lực: ưu tiên khai riêng cho SKU, nếu không thì lấy của nhà máy. */
  moq: MoqSpec | null;
}

/** Bản ghi cấu hình mạng lưới là singleton — luôn dùng id = 1. */
const CONFIG_ID = 1;

@Injectable()
export class PlanningNetworkService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Đọc cấu hình mạng lưới. Leadtime thông quan và về kho gốc dùng hằng số
   * 10 ngày, không lấy min-max từ DB.
   */
  async getRawConfig() {
    const existing = await this.prisma.planningNetworkConfig.findFirst({
      orderBy: { id: 'asc' },
    });
    if (existing) return existing;
    return this.prisma.planningNetworkConfig.create({
      data: { id: CONFIG_ID },
    });
  }

  async getNetworkConfig(): Promise<NetworkLeadtimeConfig> {
    await this.getRawConfig();
    return {
      customs: { min: CUSTOMS_LEADTIME_DAYS, max: CUSTOMS_LEADTIME_DAYS },
      inbound: { min: INBOUND_LEADTIME_DAYS, max: INBOUND_LEADTIME_DAYS },
    };
  }

  async updateConfig(dto: UpdatePlanningNetworkConfigDto) {
    const current = await this.getRawConfig();
    const merged = { ...current, ...stripUndefined(dto) };

    this.assertOrdered(
      'Thông quan',
      merged.customsLeadtimeMin,
      merged.customsLeadtimeMax,
    );
    this.assertOrdered(
      'Về công ty',
      merged.inboundLeadtimeMin,
      merged.inboundLeadtimeMax,
    );

    return this.prisma.planningNetworkConfig.update({
      where: { id: current.id },
      data: stripUndefined(dto),
    });
  }

  /** Thời gian sản xuất của toàn bộ nhà máy active, khoá theo factoryId. */
  async getFactoryLeadtimes(): Promise<Map<number, FactoryLeadtimeConfig>> {
    const factories = await this.prisma.factory.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        productionLeadtimeMin: true,
        productionLeadtimeMax: true,
      },
    });

    return new Map(
      factories.map((factory) => {
        const days = singleLeadtimeDays(
          factory.productionLeadtimeMin,
          factory.productionLeadtimeMax,
        );
        return [
          factory.id,
          {
            factoryId: factory.id,
            factoryName: factory.name,
            production:
              days == null ? null : { min: days, max: days },
            productionDays: days,
          } satisfies FactoryLeadtimeConfig,
        ];
      }),
    );
  }

  /**
   * Nhà máy cung cấp cho từng SKU, kèm override leadtime và MOQ theo SKU.
   *
   * Chọn theo mapping `factory_products` thay vì suy từ nhà cung cấp của đơn
   * đặt gần nhất: quan hệ SKU ↔ nhà máy là dữ liệu chủ đích do người dùng khai,
   * còn lịch sử đặt hàng chỉ phản ánh quá khứ.
   */
  async getProductFactoryMap(
    productIds: number[],
  ): Promise<Map<number, ProductFactoryMapping>> {
    const result = new Map<number, ProductFactoryMapping>();
    if (productIds.length === 0) return result;

    const mappings = await this.prisma.factory_products.findMany({
      where: {
        productId: { in: productIds },
        isActive: true,
        factories: { isActive: true },
      },
      select: {
        productId: true,
        factoryId: true,
        role: true,
        priority: true,
        leadtimeDays: true,
        moq: true,
        moqValue: true,
        moqBasis: true,
        moqUnit: true,
        moqIncrement: true,
        factories: {
          select: {
            moq: true,
            moqValue: true,
            moqBasis: true,
            moqUnit: true,
            moqScope: true,
            moqIncrement: true,
          },
        },
      },
      // primary trước backup, trong cùng vai trò thì priority nhỏ hơn thắng.
      orderBy: [{ role: 'asc' }, { priority: 'asc' }, { id: 'asc' }],
    });

    for (const mapping of mappings) {
      const current = result.get(mapping.productId);
      if (current && current.role === 'primary' && mapping.role !== 'primary') {
        continue;
      }
      if (
        !current ||
        (current.role !== 'primary' && mapping.role === 'primary')
      ) {
        // MOQ riêng của SKU ưu tiên hơn MOQ chung của nhà máy: dòng mapping là
        // thoả thuận cụ thể cho sản phẩm đó.
        const moq =
          normalizeMoqSpec(mapping, 'PER_LINE') ??
          normalizeMoqSpec(mapping.factories, 'PER_ORDER');
        result.set(mapping.productId, {
          factoryId: mapping.factoryId,
          role: mapping.role,
          leadtimeDays: mapping.leadtimeDays,
          moq,
        });
      }
    }

    return result;
  }

  private assertOrdered(label: string, min: number, max: number) {
    if (min > max) {
      throw new BadRequestException(
        `${label}: số ngày nhanh nhất không thể lớn hơn chậm nhất (đang là ${min} / ${max}).`,
      );
    }
  }
}

function stripUndefined<T extends Record<string, any>>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
