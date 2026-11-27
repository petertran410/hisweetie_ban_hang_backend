import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  BASE_PRICE_BOOK_ID,
  BASE_PRICE_BOOK_NAME,
  CostLine,
  PriceLine,
} from './price-change.constants';
import { toNum } from './price-change.calc';
import type { PcItemDto } from './dto';

type Db = Prisma.TransactionClient | PrismaService;

export interface CurrentValueRow {
  productId: number;
  code: string;
  name: string;
  unit: string | null;
  isActive: boolean;
  type: number;
  /** branchId → giá vốn hiện tại (null = chưa có dòng tồn kho). */
  costs: Record<number, number | null>;
  /** priceBookId → giá hiện tại (0 = Bảng giá chung; null = chưa có trong bảng giá). */
  prices: Record<number, number | null>;
}

export interface BuiltItem {
  sort: number;
  productId: number;
  productCode: string;
  productName: string;
  costs: CostLine[];
  prices: PriceLine[];
}

/** Dữ liệu gốc cho form + chụp giá hiện tại trên POS (giá cũ của phiếu). */
@Injectable()
export class PriceChangeReferenceService {
  constructor(private readonly prisma: PrismaService) {}

  async getReference() {
    const [branches, priceBooks] = await Promise.all([
      this.prisma.branch.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
        orderBy: { id: 'asc' },
      }),
      this.prisma.priceBook.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return {
      branches,
      priceBooks: [
        { id: BASE_PRICE_BOOK_ID, name: BASE_PRICE_BOOK_NAME },
        ...priceBooks,
      ],
    };
  }

  /** Giá vốn theo chi nhánh + giá theo bảng giá hiện tại của các sản phẩm. */
  async currentValues(
    productIds: number[],
    branchIds: number[] = [],
    priceBookIds: number[] = [],
    db: Db = this.prisma,
  ): Promise<CurrentValueRow[]> {
    const ids = [...new Set(productIds)];
    if (!ids.length) return [];
    const realBooks = priceBookIds.filter((id) => id !== BASE_PRICE_BOOK_ID);
    const [products, inventories, details] = await Promise.all([
      db.product.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          code: true,
          name: true,
          unit: true,
          isActive: true,
          type: true,
          basePrice: true,
        },
      }),
      db.inventory.findMany({
        where: { productId: { in: ids }, branchId: { in: branchIds } },
        select: { productId: true, branchId: true, cost: true },
      }),
      db.priceBookDetail.findMany({
        where: { productId: { in: ids }, priceBookId: { in: realBooks } },
        select: {
          productId: true,
          priceBookId: true,
          price: true,
          isActive: true,
        },
      }),
    ]);
    return products.map((p) => {
      const costs: Record<number, number | null> = {};
      for (const b of branchIds) {
        const inv = inventories.find(
          (i) => i.productId === p.id && i.branchId === b,
        );
        costs[b] = inv ? toNum(inv.cost) : null;
      }
      const prices: Record<number, number | null> = {};
      for (const pb of priceBookIds) {
        if (pb === BASE_PRICE_BOOK_ID) {
          prices[pb] = toNum(p.basePrice);
          continue;
        }
        const d = details.find(
          (x) => x.productId === p.id && x.priceBookId === pb,
        );
        prices[pb] = d && d.isActive ? toNum(d.price) : null;
      }
      return {
        productId: p.id,
        code: p.code,
        name: p.name,
        unit: p.unit,
        isActive: p.isActive,
        type: p.type,
        costs,
        prices,
      };
    });
  }

  /**
   * Dựng dòng phiếu từ dữ liệu người dùng: mỗi dòng có đủ các cột đã chọn,
   * kèm tên + giá cũ chụp từ POS. Ô không nhập giá mới → newX = null.
   */
  async buildItems(
    items: PcItemDto[],
    costBranchIds: number[],
    priceBookIds: number[],
    db: Db = this.prisma,
  ): Promise<BuiltItem[]> {
    const realBooks = priceBookIds.filter((id) => id !== BASE_PRICE_BOOK_ID);
    const [branches, books] = await Promise.all([
      db.branch.findMany({
        where: { id: { in: costBranchIds } },
        select: { id: true, name: true },
      }),
      db.priceBook.findMany({
        where: { id: { in: realBooks } },
        select: { id: true, name: true },
      }),
    ]);
    if (branches.length !== costBranchIds.length)
      throw new BadRequestException('Có chi nhánh không tồn tại');
    if (books.length !== realBooks.length)
      throw new BadRequestException('Có bảng giá không tồn tại');
    const branchName = new Map(branches.map((b) => [b.id, b.name]));
    const bookName = new Map<number, string>([
      [BASE_PRICE_BOOK_ID, BASE_PRICE_BOOK_NAME],
      ...books.map((b) => [b.id, b.name] as [number, string]),
    ]);

    const current = await this.currentValues(
      items.map((i) => i.productId),
      costBranchIds,
      priceBookIds,
      db,
    );
    const byId = new Map(current.map((c) => [c.productId, c]));
    const missing = items.filter((i) => !byId.has(i.productId));
    if (missing.length) {
      throw new BadRequestException(
        `Không tìm thấy sản phẩm #${missing.map((m) => m.productId).join(', #')}`,
      );
    }

    return items.map((item, idx) => {
      const cur = byId.get(item.productId)!;
      const stray =
        item.costs.some(
          (c) => c.newCost != null && !costBranchIds.includes(c.branchId),
        ) ||
        item.prices.some(
          (p) => p.newPrice != null && !priceBookIds.includes(p.priceBookId),
        );
      if (stray) {
        throw new BadRequestException(
          `${cur.code}: có giá mới ở chi nhánh / bảng giá chưa được chọn`,
        );
      }
      return {
        sort: idx,
        productId: cur.productId,
        productCode: cur.code,
        productName: cur.name,
        costs: costBranchIds.map((branchId) => ({
          branchId,
          branchName: branchName.get(branchId) ?? `#${branchId}`,
          oldCost: cur.costs[branchId] ?? null,
          newCost: toNum(
            item.costs.find((c) => c.branchId === branchId)?.newCost,
          ),
        })),
        prices: priceBookIds.map((priceBookId) => ({
          priceBookId,
          priceBookName: bookName.get(priceBookId) ?? `#${priceBookId}`,
          oldPrice: cur.prices[priceBookId] ?? null,
          newPrice: toNum(
            item.prices.find((p) => p.priceBookId === priceBookId)?.newPrice,
          ),
        })),
      };
    });
  }
}
