import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as ExcelJS from 'exceljs';
import { INVOICE_STATUS, getStatusLabel } from 'src/invoices/dto';
import { recalcCustomerDebt } from 'src/common/customer-debt.util';

@Injectable()
export class ImportService {
  constructor(private prisma: PrismaService) {}

  async importProducts(
    file: Express.Multer.File,
    options: {
      updateStock?: boolean;
      updateDescription?: boolean;
      updateCost?: boolean;
      branchId?: number;
    },
  ) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer as any);

    const worksheet =
      workbook.getWorksheet('ProductTemplate') || workbook.worksheets[0];
    if (!worksheet) {
      throw new BadRequestException('Excel file is empty');
    }

    // --- 1. Lookup tất cả branches ---
    const branches = await this.prisma.branch.findMany({
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
    });
    const branchMap = new Map(branches.map((b) => [b.id, b.name]));

    if (branches.length === 0) {
      throw new BadRequestException('No branch found in system');
    }

    // --- 2. Parse header row → build column map ---
    const headerRow = worksheet.getRow(1);
    const columnMap: Record<string, number> = {};
    const branchColumnMap: {
      colIndex: number;
      branchId: number;
      field: 'onHand' | 'cost';
    }[] = [];

    headerRow.eachCell((cell, colNumber) => {
      const header = cell.value?.toString()?.trim() || '';
      const headerLower = header.toLowerCase();

      // Fixed columns
      if (headerLower === 'loại hàng') columnMap['typeText'] = colNumber;
      else if (
        headerLower.includes('nhóm hàng') ||
        headerLower.includes('nhom hang')
      )
        columnMap['categoryText'] = colNumber;
      else if (headerLower === 'mã hàng' || headerLower === 'ma hang')
        columnMap['code'] = colNumber;
      else if (headerLower === 'tên hàng' || headerLower === 'ten hang')
        columnMap['name'] = colNumber;
      else if (headerLower === 'thương hiệu' || headerLower === 'thuong hieu')
        columnMap['tradeMarkName'] = colNumber;
      else if (headerLower === 'giá bán' || headerLower === 'gia ban')
        columnMap['basePrice'] = colNumber;
      else if (
        headerLower === 'tồn ít nhất' ||
        headerLower === 'tồn nhỏ nhất' ||
        headerLower === 'ton it nhat'
      )
        columnMap['minQuality'] = colNumber;
      else if (
        headerLower === 'tồn nhiều nhất' ||
        headerLower === 'tồn lớn nhất' ||
        headerLower === 'ton nhieu nhat'
      )
        columnMap['maxQuality'] = colNumber;
      else if (
        headerLower === 'đơn vị tính' ||
        headerLower === 'don vi tinh' ||
        headerLower === 'đvt'
      )
        columnMap['unit'] = colNumber;
      else if (
        headerLower.includes('thuộc tính') ||
        headerLower.includes('thuoc tinh')
      )
        columnMap['attributesText'] = colNumber;
      else if (
        headerLower.includes('mã hàng cha') ||
        headerLower.includes('mã hh liên quan')
      )
        columnMap['relatedCode'] = colNumber;
      else if (headerLower.includes('ảnh') || headerLower.includes('hình ảnh'))
        columnMap['imageUrls'] = colNumber;
      else if (headerLower === 'trọng lượng' || headerLower === 'trong luong')
        columnMap['weight'] = colNumber;
      else if (
        headerLower.includes('trọng lượng vận chuyển') ||
        headerLower.includes('trong luong van chuyen')
      )
        columnMap['shippingWeight'] = colNumber;
      else if (
        headerLower === 'vat' ||
        headerLower.includes('thuế') ||
        headerLower.includes('thue')
      )
        columnMap['vat'] = colNumber;
      else if (
        headerLower.includes('bán trực tiếp') ||
        headerLower.includes('ban truc tiep')
      )
        columnMap['isDirectSale'] = colNumber;
      else if (headerLower === 'mô tả' || headerLower === 'mo ta')
        columnMap['description'] = colNumber;
      else if (
        headerLower.includes('thành phần') ||
        headerLower.includes('thanh phan') ||
        headerLower.includes('hàng thành phần')
      )
        columnMap['componentsText'] = colNumber;

      // Dynamic branch columns: "Tồn kho - {branchName}" / "Giá vốn - {branchName}"
      for (const b of branches) {
        if (header === `Tồn kho - ${b.name}`) {
          branchColumnMap.push({
            colIndex: colNumber,
            branchId: b.id,
            field: 'onHand',
          });
        } else if (header === `Giá vốn - ${b.name}`) {
          branchColumnMap.push({
            colIndex: colNumber,
            branchId: b.id,
            field: 'cost',
          });
        }
      }
    });

    // Helper to read cell by mapped column
    const getCellStr = (row: ExcelJS.Row, key: string): string => {
      const col = columnMap[key];
      if (!col) return '';
      return row.getCell(col).value?.toString()?.trim() || '';
    };
    const getCellNum = (row: ExcelJS.Row, key: string): number => {
      const col = columnMap[key];
      if (!col) return 0;
      return this.parseNumber(row.getCell(col).value);
    };

    // --- 3. Parse rows ---
    const rawRows: any[] = [];
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber <= 1) return;

      const code = getCellStr(row, 'code');
      const name = getCellStr(row, 'name');
      if (!code || !name) return;

      // Parse branch inventories
      const branchInventories: {
        branchId: number;
        onHand: number;
        cost: number;
      }[] = [];
      const branchDataMap = new Map<number, { onHand: number; cost: number }>();

      for (const col of branchColumnMap) {
        const val = this.parseNumber(row.getCell(col.colIndex).value);
        if (!branchDataMap.has(col.branchId)) {
          branchDataMap.set(col.branchId, { onHand: 0, cost: 0 });
        }
        branchDataMap.get(col.branchId)![col.field] = val;
      }
      branchDataMap.forEach((data, branchId) => {
        branchInventories.push({ branchId, ...data });
      });

      rawRows.push({
        rowNumber,
        typeText: getCellStr(row, 'typeText'),
        categoryText: getCellStr(row, 'categoryText'),
        code,
        name,
        tradeMarkName: getCellStr(row, 'tradeMarkName'),
        basePrice: getCellNum(row, 'basePrice'),
        minQuality: getCellNum(row, 'minQuality'),
        maxQuality: getCellNum(row, 'maxQuality'),
        unit: getCellStr(row, 'unit'),
        attributesText: getCellStr(row, 'attributesText'),
        relatedCode: getCellStr(row, 'relatedCode'),
        imageUrls: getCellStr(row, 'imageUrls'),
        weight: getCellNum(row, 'weight'),
        shippingWeight: getCellStr(row, 'shippingWeight')
          ? getCellNum(row, 'shippingWeight')
          : null,
        vat: getCellStr(row, 'vat') ? getCellNum(row, 'vat') : null,
        isDirectSale: getCellStr(row, 'isDirectSale') === '1',
        description: getCellStr(row, 'description'),
        componentsText: getCellStr(row, 'componentsText'),
        branchInventories,
      });
    });

    if (rawRows.length === 0) {
      throw new BadRequestException('No valid data rows found');
    }

    // --- 4. Batch lookup: existing products, trademarks ---
    const allCodes = rawRows.map((r) => r.code);
    const existingProducts = await this.prisma.product.findMany({
      where: { code: { in: allCodes } },
      select: { id: true, code: true },
    });
    const existingProductMap = new Map(
      existingProducts.map((p) => [p.code, p.id]),
    );

    const tradeMarkCache = new Map<string, number>();
    const allTradeMarks = await this.prisma.tradeMark.findMany({
      select: { id: true, name: true },
    });
    allTradeMarks.forEach((tm) =>
      tradeMarkCache.set(tm.name.toLowerCase(), tm.id),
    );

    // --- 5. Process each row ---
    const imported: any[] = [];
    const updated: any[] = [];
    const errors: any[] = [];

    for (const row of rawRows) {
      try {
        const productType = this.mapProductType(row.typeText);
        const { parentName, middleName, childName } = this.parseCategoryText(
          row.categoryText,
        );

        if (parentName) await this.ensureCategory(parentName, 'parent');
        if (middleName) await this.ensureCategory(middleName, 'middle');
        if (childName) await this.ensureCategory(childName, 'child');

        // Resolve tradeMarkId
        let tradeMarkId: number | null = null;
        if (row.tradeMarkName) {
          const cached = tradeMarkCache.get(row.tradeMarkName.toLowerCase());
          if (cached) {
            tradeMarkId = cached;
          } else {
            const newTm = await this.prisma.tradeMark.create({
              data: { name: row.tradeMarkName },
            });
            tradeMarkCache.set(row.tradeMarkName.toLowerCase(), newTm.id);
            tradeMarkId = newTm.id;
          }
        }

        const fullName = this.buildFullName(row.name, row.attributesText);
        const existingId = existingProductMap.get(row.code);

        if (existingId) {
          // --- UPDATE existing product ---
          const updateData: any = {
            name: row.name,
            fullName,
            type: productType,
            parentName,
            middleName,
            childName,
            basePrice: row.basePrice,
            unit: row.unit || undefined,
            weight: row.weight || undefined,
            ...(row.shippingWeight !== null && {
              shippingWeight: row.shippingWeight,
            }),
            ...(row.vat !== null && { vat: row.vat }),
            isDirectSale: row.isDirectSale,
            attributesText: row.attributesText || undefined,
          };

          if (tradeMarkId) {
            updateData.tradeMarkId = tradeMarkId;
          }

          if (options.updateDescription) {
            updateData.description = row.description || null;
          }

          await this.prisma.product.update({
            where: { id: existingId },
            data: updateData,
          });

          // Update inventory cho từng branch
          for (const inv of row.branchInventories) {
            const bName = branchMap.get(inv.branchId) || '';
            await this.upsertInventory(
              existingId,
              row.code,
              row.name,
              { id: inv.branchId, name: bName },
              {
                cost: inv.cost,
                onHand: inv.onHand,
                minQuality: row.minQuality,
                maxQuality: row.maxQuality,
                weight: row.weight,
              },
              options,
            );
          }

          // Update images
          if (row.imageUrls) {
            await this.syncProductImages(existingId, row.imageUrls);
          }

          // Update components (combo/manufacturing)
          if ((productType === 1 || productType === 4) && row.componentsText) {
            await this.syncProductComponents(existingId, row.componentsText);
          }

          // masterProductId
          if (row.relatedCode) {
            const masterId = existingProductMap.get(row.relatedCode);
            if (masterId) {
              await this.prisma.product.update({
                where: { id: existingId },
                data: { masterProductId: masterId },
              });
            }
          }

          updated.push({ code: row.code, id: existingId });
        } else {
          // --- CREATE new product ---
          const product = await this.prisma.product.create({
            data: {
              code: row.code,
              name: row.name,
              fullName,
              type: productType,
              parentName,
              middleName,
              childName,
              ...(tradeMarkId && { tradeMarkId }),
              basePrice: row.basePrice,
              unit: row.unit || undefined,
              weight: row.weight || undefined,
              ...(row.shippingWeight !== null && {
                shippingWeight: row.shippingWeight,
              }),
              ...(row.vat !== null && { vat: row.vat }),
              isDirectSale: row.isDirectSale,
              description: row.description || undefined,
              attributesText: row.attributesText || undefined,
            },
          });

          existingProductMap.set(row.code, product.id);

          // Create inventory cho từng branch
          for (const inv of row.branchInventories) {
            // Bỏ qua branch không có dữ liệu
            if (inv.onHand === 0 && inv.cost === 0) continue;

            const bName = branchMap.get(inv.branchId) || '';
            await this.prisma.inventory.create({
              data: {
                productId: product.id,
                productCode: row.code,
                productName: row.name,
                branchId: inv.branchId,
                branchName: bName,
                cost: inv.cost,
                onHand: inv.onHand,
                reserved: 0,
                onOrder: 0,
                minQuality: row.minQuality,
                maxQuality: row.maxQuality,
                totalWeight: this.calculateTotalWeight(row.weight, inv.onHand),
              },
            });
          }

          // Create images
          if (row.imageUrls) {
            await this.syncProductImages(product.id, row.imageUrls);
          }

          // Create components
          if ((productType === 1 || productType === 4) && row.componentsText) {
            await this.syncProductComponents(product.id, row.componentsText);
          }

          // Handle related product (masterProductId)
          if (row.relatedCode) {
            const masterId = existingProductMap.get(row.relatedCode);
            if (masterId) {
              await this.prisma.product.update({
                where: { id: product.id },
                data: { masterProductId: masterId },
              });
            }
          }

          imported.push({ code: row.code, id: product.id });
        }
      } catch (error) {
        errors.push({
          row: row.rowNumber,
          code: row.code,
          error: error.message,
        });
      }
    }

    return {
      total: rawRows.length,
      imported: imported.length,
      updated: updated.length,
      failed: errors.length,
      errors,
    };
  }

  // ========== PRIVATE HELPERS ==========

  private parseNumber(value: any): number {
    if (value === null || value === undefined || value === '') return 0;
    const num = Number(value.toString().replace(/,/g, ''));
    return isNaN(num) ? 0 : num;
  }

  private mapProductType(text: string): number {
    const map: Record<string, number> = {
      combo: 1,
      'hàng hóa': 2,
      'dịch vụ': 3,
      'hàng sản xuất': 4,
    };
    return map[text.toLowerCase()] ?? 2;
  }

  // --- FIX LỖI 5: Thêm buildFullName giống products.service.ts ---
  private buildFullName(name: string, attributesText: string | null): string {
    if (!attributesText) return name;
    const attrs = attributesText
      .split('|')
      .map((attr) => {
        const [, value] = attr.split(':');
        return value?.trim() || '';
      })
      .filter(Boolean);
    if (attrs.length === 0) return name;
    return `${name} - ${attrs.join(' - ')}`;
  }

  // --- FIX LỖI 9: Tính totalWeight giống products.service.ts ---
  private calculateTotalWeight(weight: any, onHand: any): number {
    const w = weight ? Number(weight) : 0;
    const q = onHand ? Number(onHand) : 0;
    if (w === 0) return 0;
    return w * q;
  }

  private parseCategoryText(categoryText: string): {
    parentName: string | null;
    middleName: string | null;
    childName: string | null;
  } {
    if (!categoryText)
      return { parentName: null, middleName: null, childName: null };
    const parts = categoryText.split('>>').map((p) => p.trim());
    return {
      parentName: parts[0] || null,
      middleName: parts[1] || null,
      childName: parts[2] || null,
    };
  }

  private async ensureCategory(name: string, type: string) {
    if (!name) return;
    const existing = await this.prisma.category.findUnique({
      where: { type_name: { type, name } },
    });
    if (!existing) {
      await this.prisma.category.create({
        data: { name, type } as any,
      });
    }
  }

  private async upsertInventory(
    productId: number,
    productCode: string,
    productName: string,
    branch: { id: number; name: string },
    row: {
      cost: number;
      onHand: number;
      minQuality: number;
      maxQuality: number;
      weight: number;
    },
    options: { updateStock?: boolean; updateCost?: boolean },
  ) {
    const existing = await this.prisma.inventory.findUnique({
      where: { productId_branchId: { productId, branchId: branch.id } },
    });

    if (existing) {
      const updateData: any = {
        productCode,
        productName,
        minQuality: row.minQuality,
        maxQuality: row.maxQuality,
      };
      if (options.updateStock) {
        updateData.onHand = row.onHand;
        updateData.totalWeight = this.calculateTotalWeight(
          row.weight,
          row.onHand,
        );
      }
      if (options.updateCost) {
        updateData.cost = row.cost;
      }
      await this.prisma.inventory.update({
        where: { productId_branchId: { productId, branchId: branch.id } },
        data: updateData,
      });
    } else {
      await this.prisma.inventory.create({
        data: {
          productId,
          productCode,
          productName,
          branchId: branch.id,
          branchName: branch.name,
          cost: row.cost,
          onHand: row.onHand,
          reserved: 0,
          onOrder: 0,
          minQuality: row.minQuality,
          maxQuality: row.maxQuality,
          totalWeight: this.calculateTotalWeight(row.weight, row.onHand),
        },
      });
    }
  }

  private async syncProductImages(productId: number, imageUrlsText: string) {
    const urls = imageUrlsText
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);

    if (urls.length === 0) return;

    await this.prisma.productImage.deleteMany({ where: { productId } });
    await this.prisma.productImage.createMany({
      data: urls.map((url) => ({ productId, image: url })),
    });
  }

  // --- FIX LỖI 6: Thêm inputMode vào component ---
  private async syncProductComponents(
    productId: number,
    componentsText: string,
  ) {
    // Format: "HH000023:1,HH000016:2" hoặc "HH000023:1:gram,HH000016:2:quantity"
    const parts = componentsText
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const components: { code: string; quantity: number; inputMode: string }[] =
      [];

    for (const part of parts) {
      const segments = part.split(':');
      const code = segments[0]?.trim();
      const qty = segments[1]?.trim();
      const mode = segments[2]?.trim() || 'gram';
      if (code && qty) {
        components.push({
          code,
          quantity: parseFloat(qty) || 1,
          inputMode: mode,
        });
      }
    }

    if (components.length === 0) return;

    const codes = components.map((c) => c.code);
    const products = await this.prisma.product.findMany({
      where: { code: { in: codes } },
      select: { id: true, code: true },
    });
    const productMap = new Map(products.map((p) => [p.code, p.id]));

    await this.prisma.productComponent.deleteMany({
      where: { comboProductId: productId },
    });

    const createData = components
      .filter((c) => productMap.has(c.code))
      .map((c) => ({
        comboProductId: productId,
        componentProductId: productMap.get(c.code)!,
        quantity: c.quantity,
        inputMode: c.inputMode,
      }));

    if (createData.length > 0) {
      await this.prisma.productComponent.createMany({ data: createData });
    }
  }

  // ========== IMPORT CUSTOMERS (KHÔNG THAY ĐỔI) ==========

  async importCustomers(file: Express.Multer.File) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer as any);

    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      throw new BadRequestException('Excel file is empty');
    }

    const customers: any[] = [];
    const errors: any[] = [];

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;

      try {
        const codeValue = row.getCell(1).value;
        const nameValue = row.getCell(2).value;
        const phoneValue = row.getCell(3).value;
        const facebookValue = row.getCell(4).value;
        const zaloValue = row.getCell(5).value;
        const addressValue = row.getCell(6).value;
        const notesValue = row.getCell(7).value;
        const customerTypeIdValue = row.getCell(8).value;
        const isActiveValue = row.getCell(9).value;

        const customer = {
          code: codeValue?.toString() || null,
          name: nameValue?.toString() || '',
          phone: phoneValue?.toString() || null,
          facebook: facebookValue?.toString() || null,
          zalo: zaloValue?.toString() || null,
          address: addressValue?.toString() || null,
          notes: notesValue?.toString() || null,
          customerTypeId:
            customerTypeIdValue && customerTypeIdValue.toString()
              ? parseInt(customerTypeIdValue.toString())
              : null,
          isActive:
            isActiveValue && isActiveValue.toString()
              ? isActiveValue.toString().toLowerCase() === 'true'
              : true,
        };

        if (!customer.name) {
          errors.push({
            row: rowNumber,
            error: 'Name is required',
          });
          return;
        }

        customers.push(customer);
      } catch (error) {
        errors.push({
          row: rowNumber,
          error: error.message,
        });
      }
    });

    const imported: any[] = [];
    const failed: any[] = [];

    for (const customer of customers) {
      try {
        const created = await this.prisma.customer.create({
          data: customer,
        });
        imported.push(created);
      } catch (error) {
        failed.push({
          customer: customer.name,
          error: error.message,
        });
      }
    }

    return {
      total: customers.length,
      imported: customers.length,
      failed: failed.length,
      errors: [...errors, ...failed],
    };
  }

  // ========== TEMPLATES ==========

  async generateProductsTemplate(branchId?: number) {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('ProductTemplate');

    // Lookup branches — filter theo branchId nếu có
    const branches = await this.prisma.branch.findMany({
      where: branchId ? { id: branchId } : undefined,
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
    });

    // Cột cố định trước inventory
    const fixedBefore = [
      { header: 'Loại hàng', key: 'typeText', width: 15 },
      {
        header: 'Nhóm hàng (Cha >> Giữa >> Con)',
        key: 'categoryText',
        width: 35,
      },
      { header: 'Mã hàng', key: 'code', width: 15 },
      { header: 'Tên hàng', key: 'name', width: 30 },
      { header: 'Thương hiệu', key: 'tradeMarkName', width: 20 },
      { header: 'Giá bán', key: 'basePrice', width: 15 },
    ];

    // Cột động: Tồn kho + Giá vốn cho mỗi branch
    const branchCols = branches.flatMap((b) => [
      { header: `Tồn kho - ${b.name}`, key: `onHand_${b.id}`, width: 18 },
      { header: `Giá vốn - ${b.name}`, key: `cost_${b.id}`, width: 18 },
    ]);

    // Cột cố định sau inventory
    const fixedAfter = [
      { header: 'Tồn ít nhất', key: 'minQuality', width: 12 },
      { header: 'Tồn nhiều nhất', key: 'maxQuality', width: 15 },
      { header: 'Đơn vị tính', key: 'unit', width: 12 },
      {
        header: 'Thuộc tính (Tên:Giá trị|...)',
        key: 'attributesText',
        width: 30,
      },
      { header: 'Mã hàng cha (đơn vị)', key: 'relatedCode', width: 18 },
      { header: 'Ảnh (url1,url2,...)', key: 'imageUrls', width: 30 },
      { header: 'Trọng lượng', key: 'weight', width: 12 },
      { header: 'Trọng lượng vận chuyển', key: 'shippingWeight', width: 20 },
      { header: 'VAT (%)', key: 'vat', width: 10 },
      { header: 'Bán trực tiếp (0/1)', key: 'isDirectSale', width: 18 },
      { header: 'Mô tả', key: 'description', width: 40 },
      {
        header: 'Thành phần (Mã:SL:mode,...)',
        key: 'componentsText',
        width: 35,
      },
    ];

    worksheet.columns = [...fixedBefore, ...branchCols, ...fixedAfter];

    // Style header
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.alignment = { horizontal: 'center' };

    // Tô màu header cột branch để phân biệt
    const fixedBeforeCount = fixedBefore.length;
    const branchColCount = branchCols.length;
    for (let i = 0; i < branchColCount; i++) {
      const cell = headerRow.getCell(fixedBeforeCount + 1 + i);
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE2EFDA' }, // xanh lá nhạt
      };
    }

    // Sample data row 1
    const sampleRow1: any = {
      typeText: 'Hàng hóa',
      categoryText: 'Nguyên liệu >> Bột >> Bột mì',
      code: 'HH000001',
      name: 'Bột mì đa dụng',
      tradeMarkName: 'Meizan',
      basePrice: 150000,
      minQuality: 10,
      maxQuality: 200,
      unit: 'Bao',
      attributesText: 'Khối lượng:25kg',
      relatedCode: '',
      imageUrls: '',
      weight: 25,
      shippingWeight: 26,
      vat: 8,
      isDirectSale: '0',
      description: 'Bột mì đa dụng 25kg',
      componentsText: '',
    };
    if (branches.length > 0) {
      sampleRow1[`onHand_${branches[0].id}`] = 50;
      sampleRow1[`cost_${branches[0].id}`] = 100000;
    }
    worksheet.addRow(sampleRow1);

    // Sample data row 2
    const sampleRow2: any = {
      typeText: 'Hàng sản xuất',
      categoryText: 'Thành phẩm',
      code: 'HH000002',
      name: 'Trà sữa trân châu',
      tradeMarkName: '',
      basePrice: 35000,
      minQuality: 0,
      maxQuality: 0,
      unit: 'Ly',
      attributesText: '',
      relatedCode: '',
      imageUrls: '',
      weight: 0,
      shippingWeight: 0,
      vat: 10,
      isDirectSale: '1',
      description: '',
      componentsText: 'HH000001:0.5:gram,HH000003:2:quantity',
    };
    worksheet.addRow(sampleRow2);

    const buffer = await workbook.xlsx.writeBuffer();
    return buffer;
  }

  async generateCustomersTemplate() {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Customers');

    worksheet.columns = [
      { header: 'Code', key: 'code', width: 15 },
      { header: 'Name', key: 'name', width: 30 },
      { header: 'Phone', key: 'phone', width: 15 },
      { header: 'Facebook', key: 'facebook', width: 20 },
      { header: 'Zalo', key: 'zalo', width: 15 },
      { header: 'Address', key: 'address', width: 40 },
      { header: 'Notes', key: 'notes', width: 30 },
      { header: 'Customer Type ID', key: 'customerTypeId', width: 18 },
      { header: 'Is Active', key: 'isActive', width: 10 },
    ];

    worksheet.addRow({
      code: 'KH001',
      name: 'Nguyen Van A',
      phone: '0901234567',
      facebook: 'nguyenvana',
      zalo: '0901234567',
      address: '123 Street, District, City',
      notes: 'VIP customer',
      customerTypeId: 1,
      isActive: 'true',
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return buffer;
  }

  async importPriceBooks(file: Express.Multer.File) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer as any);

    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      throw new BadRequestException('Excel file is empty');
    }

    // --- 1. Parse header row ---
    const headerRow = worksheet.getRow(1);
    const priceBookColumns: { colIndex: number; name: string }[] = [];
    let codeCol = 0;

    headerRow.eachCell((cell, colNumber) => {
      const header = cell.value?.toString()?.trim() || '';
      const headerLower = header.toLowerCase();

      if (headerLower === 'mã hàng' || headerLower === 'ma hang') {
        codeCol = colNumber;
      } else if (
        headerLower !== 'tên hàng' &&
        headerLower !== 'ten hang' &&
        header !== ''
      ) {
        // Từ cột 3 trở đi = tên bảng giá
        priceBookColumns.push({ colIndex: colNumber, name: header });
      }
    });

    if (codeCol === 0) {
      throw new BadRequestException(
        'Không tìm thấy cột "Mã hàng" trong file Excel',
      );
    }

    if (priceBookColumns.length === 0) {
      throw new BadRequestException(
        'Không tìm thấy cột bảng giá nào trong file Excel',
      );
    }

    // --- 2. Resolve price books: tìm hoặc tạo mới ---
    const priceBookMap = new Map<
      number,
      { priceBookId: number | null; name: string; isBasePrice: boolean }
    >();

    for (const col of priceBookColumns) {
      const nameLower = col.name.toLowerCase().trim();
      const isBasePrice =
        nameLower === 'bảng giá chung' || nameLower === 'bang gia chung';

      if (isBasePrice) {
        priceBookMap.set(col.colIndex, {
          priceBookId: null,
          name: col.name,
          isBasePrice: true,
        });
      } else {
        // Tìm bảng giá theo tên (case-insensitive)
        let priceBook = await this.prisma.priceBook.findFirst({
          where: { name: { equals: col.name, mode: 'insensitive' } },
        });

        // Nếu chưa tồn tại → tạo mới
        if (!priceBook) {
          priceBook = await this.prisma.priceBook.create({
            data: {
              name: col.name,
              isActive: true,
              isGlobal: true,
              allowNonListedProducts: true,
              warnNonListedProducts: false,
            },
          });
        }

        priceBookMap.set(col.colIndex, {
          priceBookId: priceBook.id,
          name: col.name,
          isBasePrice: false,
        });
      }
    }

    // --- 3. Process rows ---
    const errors: { row: number; code: string; error: string }[] = [];
    let updatedCount = 0;
    let createdCount = 0;
    let totalRows = 0;

    const rows: {
      rowNumber: number;
      code: string;
      prices: Map<number, number>;
    }[] = [];

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // skip header
      totalRows++;

      const codeValue = row.getCell(codeCol).value?.toString()?.trim() || '';
      if (!codeValue) {
        errors.push({ row: rowNumber, code: '', error: 'Thiếu mã hàng' });
        return;
      }

      const prices = new Map<number, number>();
      for (const col of priceBookColumns) {
        const cellValue = row.getCell(col.colIndex).value;
        const price = this.parseNumber(cellValue);
        // Set giá = 0 nếu trống/0
        prices.set(col.colIndex, price);
      }

      rows.push({ rowNumber, code: codeValue, prices });
    });

    // --- 4. Batch lookup products ---
    const allCodes = rows.map((r) => r.code);
    const products = await this.prisma.product.findMany({
      where: { code: { in: allCodes } },
      select: { id: true, code: true },
    });
    const productMap = new Map(products.map((p) => [p.code, p.id]));

    // --- 5. Process each row ---
    for (const row of rows) {
      const productId = productMap.get(row.code);
      if (!productId) {
        errors.push({
          row: row.rowNumber,
          code: row.code,
          error: `Không tìm thấy sản phẩm với mã "${row.code}"`,
        });
        continue;
      }

      for (const [colIndex, price] of row.prices) {
        const pbInfo = priceBookMap.get(colIndex);
        if (!pbInfo) continue;

        try {
          if (pbInfo.isBasePrice) {
            // Cập nhật Product.basePrice
            await this.prisma.product.update({
              where: { id: productId },
              data: { basePrice: price },
            });
            updatedCount++;
          } else {
            // Upsert PriceBookDetail
            const existing = await this.prisma.priceBookDetail.findUnique({
              where: {
                priceBookId_productId: {
                  priceBookId: pbInfo.priceBookId!,
                  productId,
                },
              },
            });

            if (existing) {
              await this.prisma.priceBookDetail.update({
                where: { id: existing.id },
                data: { price },
              });
              updatedCount++;
            } else {
              await this.prisma.priceBookDetail.create({
                data: {
                  priceBookId: pbInfo.priceBookId!,
                  productId,
                  price,
                  isActive: true,
                },
              });
              createdCount++;
            }
          }
        } catch (error: any) {
          errors.push({
            row: row.rowNumber,
            code: row.code,
            error: `Lỗi cập nhật "${pbInfo.name}": ${error.message}`,
          });
        }
      }
    }

    return {
      total: totalRows,
      created: createdCount,
      updated: updatedCount,
      failed: errors.length,
      priceBookColumns: priceBookColumns.map((c) => c.name),
      errors,
    };
  }

  // ========== TEMPLATE PRICE BOOKS ==========

  async generatePriceBooksTemplate() {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('BangGia');

    // Lấy danh sách bảng giá đang active
    const priceBooks = await this.prisma.priceBook.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
    });

    // Build columns: Mã hàng, Tên hàng, Bảng giá chung, ...các bảng giá
    const columns: { header: string; key: string; width: number }[] = [
      { header: 'Mã hàng', key: 'code', width: 20 },
      { header: 'Tên hàng', key: 'name', width: 30 },
      { header: 'Bảng giá chung', key: 'basePrice', width: 18 },
    ];

    for (const pb of priceBooks) {
      columns.push({
        header: pb.name,
        key: `pb_${pb.id}`,
        width: 18,
      });
    }

    worksheet.columns = columns;

    // Style header row
    const headerRowExcel = worksheet.getRow(1);
    headerRowExcel.font = { bold: true };
    headerRowExcel.alignment = { horizontal: 'center' };

    // Sample rows
    worksheet.addRow({
      code: 'SP001',
      name: 'Sản phẩm mẫu 1',
      basePrice: 100000,
      ...Object.fromEntries(priceBooks.map((pb) => [`pb_${pb.id}`, 95000])),
    });

    worksheet.addRow({
      code: 'SP002',
      name: 'Sản phẩm mẫu 2',
      basePrice: 200000,
      ...Object.fromEntries(priceBooks.map((pb) => [`pb_${pb.id}`, 190000])),
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return buffer;
  }

  async importInvoices(
    file: Express.Multer.File,
    options: {
      branchId?: number;
      userId: number;
      recalculateCustomerDebt?: boolean;
    },
  ) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer as any);

    const worksheet =
      workbook.getWorksheet('InvoiceTemplate') || workbook.worksheets[0];
    if (!worksheet) {
      throw new BadRequestException('Excel file is empty');
    }

    // --- 1. Tìm header row và build column map ---
    let colMap: Record<string, number> = {};
    let dataStartRow = 2;

    for (let r = 1; r <= Math.min(5, worksheet.rowCount); r++) {
      const testMap: Record<string, number> = {};
      this.buildInvoiceColumnMap(worksheet.getRow(r), testMap);
      if (testMap['invoiceCode'] && testMap['productCode']) {
        colMap = testMap;
        dataStartRow = r + 1;
        break;
      }
    }

    if (!colMap['invoiceCode'] || !colMap['productCode']) {
      throw new BadRequestException(
        'Không tìm thấy cột "Mã hóa đơn" hoặc "Mã hàng" trong file Excel',
      );
    }

    // --- 2. Parse data rows ---
    interface RawRow {
      invoiceCode: string;
      purchaseDate: any;
      sellerName: string;
      customerCode: string;
      customerName: string;
      customerPhone: string;
      customerAddress: string;
      locationName: string;
      wardName: string;
      priceBookName: string;
      productCode: string;
      productName: string;
      quantity: number;
      price: number;
      discountRatio: number;
      discount: number;
      invoiceDiscount: number;
      invoiceDiscountRatio: number;
      cashAmount: number;
      transferAmount: number;
      cardAmount: number;
      walletAmount: number;
      pointAmount: number;
      voucherAmount: number;
      voucherCode: string;
      description: string;
      rowNumber: number;
      lineTotal: number;
      excelTotalAmount: number;
      excelGrandTotal: number;
      customerPaid: number;
      createdAtExcel: any;
      updatedAtExcel: any;
      orderCode: string;
      creatorName: string;
      receiverName: string;
      receiverPhone: string;
      receiverAddress: string;
      receiverLocation: string;
      receiverWard: string;
      weight: number;
      deliveryNote: string;
      productNote: string;
      codAmount: number;
      branchName: string;
      statusText: string;
    }

    const rawRows: RawRow[] = [];
    const parseErrors: { row: number; error: string }[] = [];

    for (let r = dataStartRow; r <= worksheet.rowCount; r++) {
      const row = worksheet.getRow(r);
      const invoiceCode = this.getCellString(row, colMap['invoiceCode']);
      const productCode = this.getCellString(row, colMap['productCode']);

      if (!invoiceCode && !productCode) continue;

      if (!productCode) {
        parseErrors.push({ row: r, error: 'Thiếu mã hàng' });
        continue;
      }

      rawRows.push({
        invoiceCode,
        purchaseDate: this.getCellValue(row, colMap['purchaseDate']),
        sellerName: this.getCellString(row, colMap['sellerName']),
        customerCode: this.getCellString(row, colMap['customerCode']),
        customerName: this.getCellString(row, colMap['customerName']),
        customerPhone: this.getCellString(row, colMap['customerPhone']),
        customerAddress: this.getCellString(row, colMap['customerAddress']),
        locationName: this.getCellString(row, colMap['locationName']),
        wardName: this.getCellString(row, colMap['wardName']),
        priceBookName: this.getCellString(row, colMap['priceBookName']),
        productCode,
        productName: this.getCellString(row, colMap['productName']),
        quantity: this.getCellNumber(row, colMap['quantity']) || 1,
        price: this.getCellNumber(row, colMap['price']) || 0,
        discountRatio: this.getCellNumber(row, colMap['discountRatio']) || 0,
        discount: this.getCellNumber(row, colMap['discount']) || 0,
        invoiceDiscount:
          this.getCellNumber(row, colMap['invoiceDiscount']) || 0,
        invoiceDiscountRatio:
          this.getCellNumber(row, colMap['invoiceDiscountRatio']) || 0,
        cashAmount: this.getCellNumber(row, colMap['cashAmount']) || 0,
        transferAmount: this.getCellNumber(row, colMap['transferAmount']) || 0,
        cardAmount: this.getCellNumber(row, colMap['cardAmount']),
        walletAmount: this.getCellNumber(row, colMap['walletAmount']),
        pointAmount: this.getCellNumber(row, colMap['pointAmount']) || 0,
        voucherAmount: this.getCellNumber(row, colMap['voucherAmount']) || 0,
        voucherCode: this.getCellString(row, colMap['voucherCode']),
        description: this.getCellString(row, colMap['description']),
        rowNumber: r,
        lineTotal: this.getCellNumber(row, colMap['lineTotal']) || 0,
        excelTotalAmount: this.getCellNumber(row, colMap['totalAmount']) || 0,
        excelGrandTotal: this.getCellNumber(row, colMap['grandTotal']) || 0,
        customerPaid: this.getCellNumber(row, colMap['customerPaid']) || 0,
        createdAtExcel: this.getCellValue(row, colMap['createdAtExcel']),
        updatedAtExcel: this.getCellValue(row, colMap['updatedAtExcel']),
        orderCode: this.getCellString(row, colMap['orderCode']),
        creatorName: this.getCellString(row, colMap['creatorName']),
        receiverName: this.getCellString(row, colMap['receiverName']),
        receiverPhone: this.getCellString(row, colMap['receiverPhone']),
        receiverAddress: this.getCellString(row, colMap['receiverAddress']),
        receiverLocation: this.getCellString(row, colMap['receiverLocation']),
        receiverWard: this.getCellString(row, colMap['receiverWard']),
        weight: this.getCellNumber(row, colMap['weight']) || 0,
        deliveryNote: this.getCellString(row, colMap['deliveryNote']),
        productNote: this.getCellString(row, colMap['productNote']),
        codAmount: this.getCellNumber(row, colMap['codAmount']) || 0,
        branchName: this.getCellString(row, colMap['branchName']),
        statusText: this.getCellString(row, colMap['statusText']),
      });
    }

    // --- Cộng Điểm + Voucher vào Tiền mặt ---
    for (const row of rawRows) {
      row.cashAmount += row.pointAmount + row.voucherAmount;
    }

    // --- 3. Group rows theo mã hóa đơn ---
    interface InvoiceGroup {
      header: RawRow;
      items: RawRow[];
    }

    const groups: InvoiceGroup[] = [];
    let currentGroup: InvoiceGroup | null = null;

    for (const row of rawRows) {
      if (row.invoiceCode) {
        const existing = groups.find(
          (g) => g.header.invoiceCode === row.invoiceCode,
        );
        if (existing) {
          existing.items.push(row);
          currentGroup = existing;
        } else {
          currentGroup = { header: row, items: [row] };
          groups.push(currentGroup);
        }
      } else if (currentGroup) {
        currentGroup.items.push(row);
      } else {
        parseErrors.push({
          row: row.rowNumber,
          error: 'Dòng sản phẩm không thuộc hóa đơn nào',
        });
      }
    }

    // --- 4. Batch lookups ---
    const allProductCodes = [
      ...new Set(rawRows.map((r) => r.productCode).filter(Boolean)),
    ];
    const products = await this.prisma.product.findMany({
      where: { code: { in: allProductCodes } },
      select: { id: true, code: true, name: true, basePrice: true },
    });
    const productMap = new Map(products.map((p) => [p.code, p]));

    const allCustomerCodes = [
      ...new Set(groups.map((g) => g.header.customerCode).filter(Boolean)),
    ];
    const customers = allCustomerCodes.length
      ? await this.prisma.customer.findMany({
          where: { code: { in: allCustomerCodes } },
          select: { id: true, code: true, name: true },
        })
      : [];
    const customerMap = new Map(customers.map((c) => [c.code, c]));

    const allSellerNames = [
      ...new Set(groups.map((g) => g.header.sellerName).filter(Boolean)),
    ];
    const sellers = allSellerNames.length
      ? await this.prisma.user.findMany({
          where: {
            name: { in: allSellerNames, mode: 'insensitive' },
          },
          select: { id: true, name: true },
        })
      : [];
    const sellerMap = new Map(sellers.map((u) => [u.name.toLowerCase(), u]));

    const allPriceBookNames = [
      ...new Set(
        groups
          .map((g) => g.header.priceBookName)
          .filter((n) => n && n !== 'Bảng giá chung'),
      ),
    ];
    const priceBooks = allPriceBookNames.length
      ? await this.prisma.priceBook.findMany({
          where: {
            name: { in: allPriceBookNames, mode: 'insensitive' },
            isActive: true,
          },
          select: { id: true, name: true },
        })
      : [];
    const priceBookMap = new Map(priceBooks.map((pb) => [pb.name, pb]));

    // Lookup orders theo mã
    const allOrderCodes = [
      ...new Set(groups.map((g) => g.header.orderCode).filter(Boolean)),
    ];
    const orders = allOrderCodes.length
      ? await this.prisma.order.findMany({
          where: { code: { in: allOrderCodes } },
          select: { id: true, code: true },
        })
      : [];
    const orderCodeMap = new Map(orders.map((o) => [o.code, o]));

    // Lookup creators theo tên
    const allCreatorNames = [
      ...new Set(groups.map((g) => g.header.creatorName).filter(Boolean)),
    ];
    const creators = allCreatorNames.length
      ? await this.prisma.user.findMany({
          where: {
            name: { in: allCreatorNames, mode: 'insensitive' },
          },
          select: { id: true, name: true },
        })
      : [];
    const creatorNameMap = new Map(
      creators.map((u) => [u.name.toLowerCase(), u]),
    );

    // Lookup branches theo tên
    const allBranchNames = [
      ...new Set(groups.map((g) => g.header.branchName).filter(Boolean)),
    ];
    const branchesFromExcel = allBranchNames.length
      ? await this.prisma.branch.findMany({
          where: {
            name: { in: allBranchNames, mode: 'insensitive' },
          },
          select: { id: true, name: true },
        })
      : [];
    const branchNameMap = new Map(
      branchesFromExcel.map((b) => [b.name.toLowerCase(), b]),
    );

    // --- 5. Pre-fetch: invoice count + existing invoices (tối ưu) ---
    const imported: any[] = [];
    const updated: any[] = [];
    const failed: { invoiceCode?: string; error: string }[] = [];

    const invoiceCount = await this.prisma.invoice.count();
    const allInvoiceCodes = groups
      .map((g) => g.header.invoiceCode)
      .filter(Boolean);
    const existingInvoices = allInvoiceCodes.length
      ? await this.prisma.invoice.findMany({
          where: { code: { in: allInvoiceCodes } },
          select: { id: true, code: true },
        })
      : [];
    const existingInvoiceMap = new Map(
      existingInvoices.map((i) => [i.code, i.id]),
    );

    // Helper: parse Excel date
    const VN_OFFSET_MS = 7 * 60 * 60 * 1000; // UTC+7

    const parseExcelDate = (val: any): Date | null => {
      if (!val) return null;
      if (val instanceof Date) {
        return new Date(val.getTime() - VN_OFFSET_MS);
      }
      if (typeof val === 'number') {
        const excelEpoch = new Date(1899, 11, 30);
        return new Date(excelEpoch.getTime() + val * 86400000 - VN_OFFSET_MS);
      }
      const parsed = new Date(val);
      return isNaN(parsed.getTime()) ? null : parsed;
    };

    // --- 6. Batch processing ---
    const BATCH_SIZE = 500;
    let autoCodeIndex = 0;
    const affectedCustomerIds = new Set<number>();

    for (
      let batchStart = 0;
      batchStart < groups.length;
      batchStart += BATCH_SIZE
    ) {
      const batch = groups.slice(batchStart, batchStart + BATCH_SIZE);

      const batchResults = await this.prisma.$transaction(
        async (tx) => {
          const batchImported: any[] = [];
          const batchUpdated: any[] = [];

          // === PRE-CLEANUP: Batch delete tất cả invoice cần update ===
          const updateInvoiceIds = batch
            .map((g) => existingInvoiceMap.get(g.header.invoiceCode))
            .filter((id): id is number => !!id);

          if (updateInvoiceIds.length > 0) {
            const oldPayments = await tx.invoicePayment.findMany({
              where: { invoiceId: { in: updateInvoiceIds } },
              select: { cashFlowId: true },
            });
            const oldCashFlowIds = oldPayments
              .map((p) => p.cashFlowId)
              .filter((id): id is number => id != null);

            await tx.invoicePayment.deleteMany({
              where: { invoiceId: { in: updateInvoiceIds } },
            });
            if (oldCashFlowIds.length > 0) {
              await tx.cashFlow.deleteMany({
                where: { id: { in: oldCashFlowIds } },
              });
            }
            await tx.invoiceDetail.deleteMany({
              where: { invoiceId: { in: updateInvoiceIds } },
            });
            await tx.invoiceDelivery.deleteMany({
              where: { invoiceId: { in: updateInvoiceIds } },
            });
          }

          // === Collected data cho batch createMany ===
          const allDetails: any[] = [];
          const allDeliveries: any[] = [];
          const pendingPayments: {
            invoiceId: number;
            invoiceCode: string;
            branchId: number;
            purchaseDate: Date;
            importCreatedAt: Date;
            customer: any;
            cashAmount: number;
            transferAmount: number;
            cardAmount: number;
            walletAmount: number;
            customerName: string;
            customerPhone: string;
            customerAddress: string;
            userId: number;
          }[] = [];

          for (const group of batch) {
            try {
              const h = group.header;

              // Lọc mã HĐ: skip HDSPE, HDTTS, v.v.
              if (h.invoiceCode && /^HD[A-Za-z]/i.test(h.invoiceCode)) {
                failed.push({
                  invoiceCode: h.invoiceCode,
                  error: `Mã hóa đơn "${h.invoiceCode}" không được phép import (chứa ký tự chữ sau HD)`,
                });
                continue;
              }

              const code =
                h.invoiceCode ||
                `HDIP${String(invoiceCount + imported.length + batchImported.length + autoCodeIndex + 1).padStart(6, '0')}`;
              if (!h.invoiceCode) autoCodeIndex++;

              const existingInvoiceId = existingInvoiceMap.get(code);
              const isUpdate = !!existingInvoiceId;

              const excelBranch = h.branchName
                ? branchNameMap.get(h.branchName.toLowerCase())
                : null;
              const invoiceBranchId =
                excelBranch?.id || options.branchId || null;

              if (!invoiceBranchId) {
                failed.push({
                  invoiceCode: code,
                  error: `Không tìm thấy chi nhánh "${h.branchName || '(trống)'}"`,
                });
                continue;
              }

              // Build invoice details
              const invoiceItems = group.items.map((item) => {
                const product = productMap.get(item.productCode);
                const price =
                  item.price || (product ? Number(product.basePrice) : 0);
                const quantity = item.quantity;
                const itemDiscount =
                  item.discount || (price * item.discountRatio) / 100;
                const totalPrice =
                  item.lineTotal > 0
                    ? item.lineTotal
                    : (price - itemDiscount) * quantity;

                return {
                  productId: product?.id || null,
                  productCode: item.productCode,
                  productName:
                    item.productName || product?.name || item.productCode,
                  quantity,
                  price,
                  discount: itemDiscount,
                  discountRatio: item.discountRatio,
                  totalPrice,
                  conditionType: 'normal',
                  note: item.productNote || '',
                };
              });

              const totalAmount =
                h.excelTotalAmount > 0
                  ? h.excelTotalAmount
                  : invoiceItems.reduce((s, i) => s + i.totalPrice, 0);
              const invoiceDiscountAmount =
                h.invoiceDiscount ||
                (totalAmount * (h.invoiceDiscountRatio || 0)) / 100;
              const grandTotal =
                h.excelGrandTotal > 0
                  ? h.excelGrandTotal
                  : totalAmount - invoiceDiscountAmount;
              const paidAmount =
                h.customerPaid > 0
                  ? h.customerPaid
                  : h.cashAmount + h.transferAmount;
              const debtAmount = grandTotal - paidAmount;

              const customer = h.customerCode
                ? customerMap.get(h.customerCode)
                : null;
              const seller = h.sellerName
                ? sellerMap.get(h.sellerName.toLowerCase())
                : null;
              const priceBook = h.priceBookName
                ? priceBookMap.get(h.priceBookName.toLowerCase())
                : null;
              const order = h.orderCode ? orderCodeMap.get(h.orderCode) : null;
              const creator = h.creatorName
                ? creatorNameMap.get(h.creatorName.toLowerCase())
                : null;
              const createdByUserId = creator?.id || options.userId;

              const purchaseDate = parseExcelDate(h.purchaseDate) || new Date();
              const importCreatedAt =
                parseExcelDate(h.createdAtExcel) || purchaseDate;
              const importUpdatedAt =
                parseExcelDate(h.updatedAtExcel) || importCreatedAt;

              const usingCod = h.codAmount > 0;

              // Xác định trạng thái từ Excel
              const excelStatusText = h.statusText?.trim().toLowerCase();
              const isCancelled =
                excelStatusText === 'đã hủy' || excelStatusText === 'da huy';

              const status = isCancelled
                ? INVOICE_STATUS.CANCELLED
                : debtAmount <= 0
                  ? INVOICE_STATUS.COMPLETED
                  : INVOICE_STATUS.PROCESSING;

              // Nếu đã hủy: không tính tiền
              const effectivePaidAmount = isCancelled ? 0 : paidAmount;
              const effectiveDebtAmount = isCancelled ? 0 : debtAmount;

              const invoiceData = {
                orderId: order?.id || null,
                customerId: customer?.id || null,
                parentCustomerId: customer?.id || null,
                branchId: invoiceBranchId,
                soldById: seller?.id || null,
                priceBookId: priceBook?.id || null,
                priceBookName: priceBook?.name || null,
                purchaseDate,
                totalAmount,
                discount: invoiceDiscountAmount,
                discountRatio: h.invoiceDiscountRatio || 0,
                grandTotal,
                paidAmount: effectivePaidAmount,
                debtAmount: effectiveDebtAmount,
                customerDebtSnapshot: null,
                status,
                statusValue: getStatusLabel(status),
                usingCod,
                description: h.description || null,
                createdBy: createdByUserId,
                createdAt: importCreatedAt,
                updatedAt: importUpdatedAt,
              };

              // Create hoặc Update invoice
              const inv = isUpdate
                ? await tx.invoice.update({
                    where: { id: existingInvoiceId },
                    data: invoiceData,
                  })
                : await tx.invoice.create({
                    data: { code, ...invoiceData },
                  });

              // Collect details
              for (const item of invoiceItems) {
                allDetails.push({
                  invoiceId: inv.id,
                  productId: item.productId,
                  productCode: item.productCode,
                  productName: item.productName,
                  quantity: item.quantity,
                  price: item.price,
                  discount: item.discount,
                  discountRatio: item.discountRatio,
                  totalPrice: item.totalPrice,
                  conditionType: item.conditionType,
                  note: item.note,
                });
              }

              // Collect delivery
              if (h.receiverName) {
                allDeliveries.push({
                  invoiceId: inv.id,
                  receiver: h.receiverName,
                  contactNumber: h.receiverPhone || '',
                  address: h.receiverAddress || '',
                  locationName: h.receiverLocation || null,
                  wardName: h.receiverWard || null,
                  weight: h.weight || null,
                  noteForDriver: h.deliveryNote || null,
                  status: 1,
                  statusValue: 'Đã giao',
                });
              }

              // Collect payment data
              if (!isCancelled && (h.cashAmount > 0 || h.transferAmount > 0)) {
                pendingPayments.push({
                  invoiceId: inv.id,
                  invoiceCode: inv.code,
                  branchId: invoiceBranchId || 1,
                  purchaseDate,
                  importCreatedAt,
                  customer,
                  cashAmount: h.cashAmount,
                  transferAmount: h.transferAmount,
                  cardAmount: h.cardAmount,
                  walletAmount: h.walletAmount,
                  customerName: h.customerName,
                  customerPhone: h.customerPhone,
                  customerAddress: h.customerAddress,
                  userId: options.userId,
                });
              }

              // Track affected customers
              if (customer?.id) {
                affectedCustomerIds.add(customer.id);
              }

              if (isUpdate) {
                batchUpdated.push(inv);
              } else {
                batchImported.push(inv);
              }
            } catch (error) {
              failed.push({
                invoiceCode:
                  group.header.invoiceCode || `Row ${group.header.rowNumber}`,
                error: error.message,
              });
            }
          }

          // === BATCH CREATE: Details ===
          if (allDetails.length > 0) {
            await tx.invoiceDetail.createMany({ data: allDetails });
          }

          // === BATCH CREATE: Deliveries ===
          if (allDeliveries.length > 0) {
            await tx.invoiceDelivery.createMany({ data: allDeliveries });
          }

          // === CREATE: CashFlows + Payments (sequential — cần cashFlowId) ===
          for (const pp of pendingPayments) {
            let paymentSeq = 0;

            const methods = [
              { amount: pp.cashAmount, method: 'cash', label: 'Tiền mặt' },
              {
                amount: pp.transferAmount,
                method: 'transfer',
                label: 'Chuyển khoản',
              },
              { amount: pp.cardAmount, method: 'card', label: 'Thẻ' },
              {
                amount: pp.walletAmount,
                method: 'ewallet',
                label: 'Ví điện tử',
              },
            ];

            for (const m of methods) {
              if (m.amount <= 0) continue;
              paymentSeq++;
              const paymentCode = `TT${pp.invoiceCode}-${paymentSeq}`;
              const cashFlow = await tx.cashFlow.create({
                data: {
                  code: paymentCode,
                  branchId: pp.branchId,
                  cashFlowGroupId: 3,
                  isReceipt: true,
                  amount: m.amount,
                  transDate: pp.purchaseDate,
                  method: m.method,
                  accountId: null,
                  partnerType: pp.customer ? 'C' : 'O',
                  partnerId: pp.customer?.id || null,
                  partnerName: pp.customer?.name || pp.customerName || null,
                  contactNumber: pp.customerPhone || null,
                  address: pp.customerAddress || null,
                  description: `Import - ${m.label} - HĐ ${pp.invoiceCode}`,
                  status: 0,
                  statusValue: 'Đã thanh toán',
                  createdBy: pp.userId,
                  usedForFinancialReporting: 1,
                  customerDebtSnapshot: null,
                  createdAt: pp.importCreatedAt,
                },
              });
              await tx.invoicePayment.create({
                data: {
                  code: paymentCode,
                  invoiceId: pp.invoiceId,
                  amount: m.amount,
                  paymentMethod: m.method,
                  paymentDate: pp.purchaseDate,
                  status: 1,
                  statusValue: 'Đã thanh toán',
                  description: `Import - ${m.label}`,
                  cashFlowId: cashFlow.id,
                  createdAt: pp.importCreatedAt,
                },
              });
            }
          }

          return { batchImported, batchUpdated };
        },
        { timeout: 300000 }, // 5 phút per batch
      );

      imported.push(...batchResults.batchImported);
      updated.push(...batchResults.batchUpdated);
    }

    // --- 7. Recalculate customer debt (nếu được yêu cầu) ---
    if (options.recalculateCustomerDebt && affectedCustomerIds.size > 0) {
      const customerIds = Array.from(affectedCustomerIds);
      const CUSTOMER_BATCH = 100;

      for (let i = 0; i < customerIds.length; i += CUSTOMER_BATCH) {
        const batchIds = customerIds.slice(i, i + CUSTOMER_BATCH);

        await this.prisma.$transaction(async (tx) => {
          for (const customerId of batchIds) {
            await this.recalculateCustomerTotals(customerId, tx);
          }
        });
      }
    }

    return {
      total: groups.length,
      imported: imported.length,
      updated: updated.length,
      failed: failed.length,
      errors: [...parseErrors, ...failed],
    };
  }

  private async recalculateCustomerTotals(customerId: number, tx: any) {
    const customer = await tx.customer.findUnique({
      where: { id: customerId },
      select: { id: true },
    });
    if (!customer) return;

    // Tính totalPurchased riêng (Formula A chỉ phụ trách totalDebt)
    const invoices = await tx.invoice.findMany({
      where: { customerId, status: { notIn: [2] } },
      select: { grandTotal: true },
    });
    const totalPurchased = invoices.reduce(
      (sum: number, inv: any) => sum + Number(inv.grandTotal),
      0,
    );

    // Delegate sang Formula A (chân lý). Pass totalPurchased để cập nhật cả 2 field cùng lúc.
    await recalcCustomerDebt(tx, customerId, { totalPurchased });
  }

  // --- Helper: build column map cho invoice ---
  private buildInvoiceColumnMap(
    row: ExcelJS.Row,
    colMap: Record<string, number>,
  ) {
    row.eachCell((cell, colNumber) => {
      const raw = cell.value?.toString()?.trim() || '';
      if (!raw) return;
      const h = raw.toLowerCase();

      if (h === 'chi nhánh' || h === 'chi nhanh')
        colMap['branchName'] = colNumber;
      else if (h.includes('mã hóa đơn') || h.includes('ma hoa don'))
        colMap['invoiceCode'] = colNumber;
      else if (
        h === 'thời gian' ||
        h === 'thoi gian' ||
        (h.includes('thời gian') &&
          !h.includes('tạo') &&
          !h.includes('cập nhật') &&
          !h.includes('tao') &&
          !h.includes('cap nhat'))
      )
        colMap['purchaseDate'] = colNumber;
      else if (h.includes('người bán') || h.includes('nguoi ban'))
        colMap['sellerName'] = colNumber;
      else if (h.includes('mã khách') || h.includes('ma khach'))
        colMap['customerCode'] = colNumber;
      else if (h.includes('tên khách') || h.includes('ten khach'))
        colMap['customerName'] = colNumber;
      else if (
        (h.includes('điện thoại') || h.includes('dien thoai')) &&
        !h.includes('người nhận') &&
        !h.includes('nguoi nhan')
      )
        colMap['customerPhone'] = colNumber;
      else if (h.includes('địa chỉ') && h.includes('khách'))
        colMap['customerAddress'] = colNumber;
      else if (h.includes('khu vực') && h.includes('khách'))
        colMap['locationName'] = colNumber;
      else if (
        (h.includes('phường') || h.includes('xã')) &&
        h.includes('khách')
      )
        colMap['wardName'] = colNumber;
      else if (h.includes('bảng giá') || h.includes('bang gia'))
        colMap['priceBookName'] = colNumber;
      else if (h.includes('mã hàng') || h.includes('ma hang'))
        colMap['productCode'] = colNumber;
      else if (h === 'tên hàng' || h === 'ten hang')
        colMap['productName'] = colNumber;
      else if (h.includes('số lượng') || h.includes('so luong'))
        colMap['quantity'] = colNumber;
      else if (h.includes('đơn giá') || h.includes('don gia'))
        colMap['price'] = colNumber;
      else if (
        h.includes('giảm giá') &&
        h.includes('%') &&
        !h.includes('hóa đơn')
      )
        colMap['discountRatio'] = colNumber;
      else if (
        h.includes('giảm giá') &&
        !h.includes('%') &&
        !h.includes('hóa đơn')
      )
        colMap['discount'] = colNumber;
      else if (h.includes('giảm giá hóa đơn') && !h.includes('%'))
        colMap['invoiceDiscount'] = colNumber;
      else if (h.includes('giảm giá hóa đơn') && h.includes('%'))
        colMap['invoiceDiscountRatio'] = colNumber;
      else if (h.includes('tiền mặt') || h.includes('tien mat'))
        colMap['cashAmount'] = colNumber;
      else if (h.includes('chuyển khoản') || h.includes('chuyen khoan'))
        colMap['transferAmount'] = colNumber;
      else if (h.includes('thẻ') || h.includes('the') || h === 'card')
        colMap['cardAmount'] = colNumber;
      else if (
        h.includes('ví') ||
        h.includes('vi') ||
        h === 'wallet' ||
        h.includes('ví điện tử')
      )
        colMap['walletAmount'] = colNumber;
      else if (h === 'điểm' || h === 'diem' || h === 'point')
        colMap['pointAmount'] = colNumber;
      else if (h === 'voucher' && !h.includes('mã'))
        colMap['voucherAmount'] = colNumber;
      else if (h.includes('mã voucher') || h.includes('ma voucher'))
        colMap['voucherCode'] = colNumber;
      else if (
        (h.includes('ghi chú') || h.includes('ghi chu')) &&
        !h.includes('hàng hóa') &&
        !h.includes('hang hoa') &&
        !h.includes('giao hàng') &&
        !h.includes('giao hang') &&
        !h.includes('trạng thái') &&
        !h.includes('trang thai')
      )
        colMap['description'] = colNumber;
      // --- Cột mới: giá trị tính sẵn từ Excel ---
      else if (h.includes('thành tiền') || h.includes('thanh tien'))
        colMap['lineTotal'] = colNumber;
      else if (h.includes('tổng tiền hàng') || h.includes('tong tien hang'))
        colMap['totalAmount'] = colNumber;
      else if (h.includes('khách cần trả') || h.includes('khach can tra'))
        colMap['grandTotal'] = colNumber;
      else if (h.includes('khách đã trả') || h.includes('khach da tra'))
        colMap['customerPaid'] = colNumber;
      else if (
        h === 'thời gian tạo' ||
        h === 'thoi gian tao' ||
        (h.includes('thời gian') && h.includes('tạo'))
      )
        colMap['createdAtExcel'] = colNumber;
      else if (
        h === 'thời gian cập nhật' ||
        h === 'thoi gian cap nhat' ||
        (h.includes('thời gian') && h.includes('cập nhật'))
      )
        colMap['updatedAtExcel'] = colNumber;
      else if (h.includes('mã đặt hàng') || h.includes('ma dat hang'))
        colMap['orderCode'] = colNumber;
      else if (h.includes('người tạo') || h.includes('nguoi tao'))
        colMap['creatorName'] = colNumber;
      else if (h === 'người nhận' || h === 'nguoi nhan')
        colMap['receiverName'] = colNumber;
      else if (
        (h.includes('điện thoại') || h.includes('dien thoai')) &&
        (h.includes('người nhận') || h.includes('nguoi nhan'))
      )
        colMap['receiverPhone'] = colNumber;
      else if (
        h.includes('địa chỉ') &&
        (h.includes('người nhận') || h.includes('nguoi nhan'))
      )
        colMap['receiverAddress'] = colNumber;
      else if (
        h.includes('khu vực') &&
        (h.includes('người nhận') || h.includes('nguoi nhan'))
      )
        colMap['receiverLocation'] = colNumber;
      else if (
        (h.includes('phường') || h.includes('xã')) &&
        (h.includes('người nhận') || h.includes('nguoi nhan'))
      )
        colMap['receiverWard'] = colNumber;
      else if (h.includes('trọng lượng') || h.includes('trong luong'))
        colMap['weight'] = colNumber;
      else if (h === 'ghi chú giao hàng' || h === 'ghi chu giao hang')
        colMap['deliveryNote'] = colNumber;
      else if (h === 'ghi chú hàng hóa' || h === 'ghi chu hang hoa')
        colMap['productNote'] = colNumber;
      else if (
        h.includes('còn cần thu') ||
        h.includes('con can thu') ||
        h === 'cod'
      )
        colMap['codAmount'] = colNumber;
      else if (
        (h === 'trạng thái' || h === 'trang thai') &&
        !h.includes('ghi chú') &&
        !h.includes('giao hàng')
      )
        colMap['statusText'] = colNumber;
    });
  }

  private getCellString(row: ExcelJS.Row, colIndex?: number): string {
    if (!colIndex) return '';
    const val = row.getCell(colIndex).value;
    return val?.toString()?.trim() || '';
  }

  private getCellNumber(row: ExcelJS.Row, colIndex?: number): number {
    if (!colIndex) return 0;
    const val = row.getCell(colIndex).value;
    if (val === null || val === undefined || val === '') return 0;
    const num = Number(String(val).replace(/,/g, ''));
    return isNaN(num) ? 0 : num;
  }

  private getCellValue(row: ExcelJS.Row, colIndex?: number): any {
    if (!colIndex) return null;
    return row.getCell(colIndex).value;
  }

  // ========== GENERATE INVOICES TEMPLATE ==========

  async generateInvoicesTemplate() {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('InvoiceTemplate');

    worksheet.columns = [
      // --- Thông tin hóa đơn ---
      { header: 'Chi nhánh', key: 'branchName', width: 18 },
      { header: 'Mã hóa đơn', key: 'invoiceCode', width: 18 },
      { header: 'Thời gian', key: 'purchaseDate', width: 18 },
      { header: 'Thời gian tạo', key: 'createdAt', width: 18 }, // MỚI
      { header: 'Thời gian cập nhật', key: 'updatedAt', width: 18 }, // MỚI
      { header: 'Mã đặt hàng', key: 'orderCode', width: 16 }, // MỚI
      { header: 'Người bán', key: 'sellerName', width: 18 },
      { header: 'Người tạo', key: 'creatorName', width: 18 }, // MỚI
      // --- Khách hàng ---
      { header: 'Mã khách hàng', key: 'customerCode', width: 16 },
      { header: 'Tên khách hàng', key: 'customerName', width: 22 },
      { header: 'Điện thoại (Khách hàng)', key: 'customerPhone', width: 22 },
      { header: 'Địa chỉ (Khách hàng)', key: 'customerAddress', width: 30 },
      { header: 'Khu vực (Khách hàng)', key: 'locationName', width: 25 },
      { header: 'Phường/Xã (Khách hàng)', key: 'wardName', width: 22 },
      // --- Giao hàng ---
      { header: 'Người nhận', key: 'receiverName', width: 20 }, // MỚI
      { header: 'Điện thoại (Người nhận)', key: 'receiverPhone', width: 22 }, // MỚI
      { header: 'Địa chỉ (Người nhận)', key: 'receiverAddress', width: 30 }, // MỚI
      { header: 'Khu vực (Người nhận)', key: 'receiverLocation', width: 25 }, // MỚI
      { header: 'Phường/Xã (Người nhận)', key: 'receiverWard', width: 22 }, // MỚI
      { header: 'Trọng lượng (gram)', key: 'weight', width: 16 }, // MỚI
      { header: 'Ghi chú giao hàng', key: 'deliveryNote', width: 25 }, // MỚI
      // --- Bảng giá ---
      { header: 'Bảng giá', key: 'priceBookName', width: 18 },
      // --- Sản phẩm ---
      { header: 'Mã hàng', key: 'productCode', width: 15 },
      { header: 'Tên hàng', key: 'productName', width: 25 },
      { header: 'Số lượng', key: 'quantity', width: 12 },
      { header: 'Đơn giá', key: 'price', width: 15 },
      { header: 'Giảm giá %', key: 'discountRatio', width: 12 },
      { header: 'Giảm giá', key: 'discount', width: 12 },
      { header: 'Thành tiền', key: 'lineTotal', width: 15 },
      { header: 'Ghi chú hàng hóa', key: 'productNote', width: 22 }, // MỚI
      // --- Tổng hóa đơn ---
      { header: 'Giảm giá hóa đơn', key: 'invoiceDiscount', width: 18 },
      { header: 'Giảm giá hóa đơn %', key: 'invoiceDiscountRatio', width: 18 },
      { header: 'Tổng tiền hàng', key: 'totalAmount', width: 15 },
      { header: 'Khách cần trả', key: 'grandTotal', width: 15 },
      { header: 'Khách đã trả', key: 'customerPaid', width: 15 },
      // --- Thanh toán ---
      { header: 'Tiền mặt', key: 'cashAmount', width: 15 },
      { header: 'Chuyển khoản', key: 'transferAmount', width: 15 },
      { header: 'Thẻ', key: 'cardAmount', width: 15 },
      { header: 'Ví', key: 'walletAmount', width: 15 },
      { header: 'Điểm', key: 'pointAmount', width: 12 },
      { header: 'Voucher', key: 'voucherAmount', width: 12 },
      { header: 'Mã Voucher', key: 'voucherCode', width: 15 },
      { header: 'Còn cần thu (COD)', key: 'codAmount', width: 16 }, // MỚI
      // --- Ghi chú ---
      { header: 'Ghi chú', key: 'description', width: 25 },
    ];

    const headerRowExcel = worksheet.getRow(1);
    headerRowExcel.font = { bold: true };
    headerRowExcel.alignment = { horizontal: 'center' };

    // Tô màu phân biệt: xanh cho cột cấp HĐ, trắng cho cột cấp sản phẩm
    const invoiceLevelCols = [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 18, 19, 20, 21, 22, 23, 24, 25,
    ];
    for (const colIdx of invoiceLevelCols) {
      const cell = headerRowExcel.getCell(colIdx);
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE2EFDA' },
      };
    }

    // === Sample: HĐ 1 — 2 sản phẩm, trả đủ bằng tiền mặt ===
    worksheet.addRow({
      branchName: 'Kho Sài Gòn',
      invoiceCode: 'HD000001',
      purchaseDate: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      orderCode: '',
      sellerName: 'Nguyễn Văn A',
      creatorName: 'Nguyễn Văn A',
      customerCode: 'KH000001',
      customerName: 'Anh Minh',
      customerPhone: '0901234567',
      customerAddress: '123 Nguyễn Huệ, Q.1',
      locationName: 'TP.HCM - Quận 1',
      wardName: 'Phường Bến Nghé',
      receiverName: 'Anh Minh',
      receiverPhone: '0901234567',
      receiverAddress: '123 Nguyễn Huệ, Q.1',
      receiverLocation: 'TP.HCM - Quận 1',
      receiverWard: 'Phường Bến Nghé',
      weight: 5000,
      deliveryNote: 'Giao giờ hành chính',
      priceBookName: 'Bảng giá chung',
      productCode: 'SP000001',
      productName: 'Sản phẩm A',
      quantity: 5,
      price: 100000,
      discount: 0,
      discountRatio: 0,
      lineTotal: 500000,
      productNote: '',
      invoiceDiscount: 0,
      invoiceDiscountRatio: 0,
      totalAmount: 650000,
      grandTotal: 650000,
      customerPaid: 650000,
      cashAmount: 650000,
      transferAmount: 0,
      cardAmount: 0,
      walletAmount: 0,
      pointAmount: 0,
      voucherAmount: 0,
      voucherCode: '',
      codAmount: 0,
      description: 'Hóa đơn mẫu 1',
    });

    worksheet.addRow({
      branchName: 'Kho Sài Gòn',
      invoiceCode: 'HD000001',
      purchaseDate: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      orderCode: '',
      sellerName: 'Nguyễn Văn A',
      creatorName: 'Nguyễn Văn A',
      customerCode: 'KH000001',
      customerName: 'Anh Minh',
      customerPhone: '0901234567',
      customerAddress: '123 Nguyễn Huệ, Q.1',
      locationName: 'TP.HCM - Quận 1',
      wardName: 'Phường Bến Nghé',
      receiverName: 'Anh Minh',
      receiverPhone: '0901234567',
      receiverAddress: '123 Nguyễn Huệ, Q.1',
      receiverLocation: 'TP.HCM - Quận 1',
      receiverWard: 'Phường Bến Nghé',
      weight: 5000,
      deliveryNote: 'Giao giờ hành chính',
      priceBookName: 'Bảng giá chung',
      // --- Chỉ khác phần sản phẩm ---
      productCode: 'SP000002',
      productName: 'Sản phẩm B',
      quantity: 1,
      price: 150000,
      discount: 0,
      discountRatio: 0,
      lineTotal: 150000,
      productNote: 'Hàng khuyến mãi',
      // --- Lặp lại tổng HĐ ---
      invoiceDiscount: 0,
      invoiceDiscountRatio: 0,
      totalAmount: 650000,
      grandTotal: 650000,
      customerPaid: 650000,
      cashAmount: 650000,
      transferAmount: 0,
      cardAmount: 0,
      walletAmount: 0,
      pointAmount: 0,
      voucherAmount: 0,
      voucherCode: '',
      codAmount: 0,
      description: 'Hóa đơn mẫu 1',
    });

    // === Sample: HĐ 2 — 1 sản phẩm, có giảm giá, trả chuyển khoản ===
    worksheet.addRow({
      branchName: 'Kho Hà Nội',
      invoiceCode: 'HD000002',
      purchaseDate: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      orderCode: 'DH000001',
      sellerName: 'Trần Thị B',
      creatorName: 'Nguyễn Văn C',
      customerCode: 'KH000234',
      customerName: 'Chị Lan',
      customerPhone: '0987654321',
      customerAddress: 'Ngõ 60 Hoàng Mai',
      locationName: 'Hà Nội - Quận Hoàng Mai',
      wardName: 'Phường Hoàng Văn Thụ',
      receiverName: '',
      receiverPhone: '',
      receiverAddress: '',
      receiverLocation: '',
      receiverWard: '',
      weight: 0,
      deliveryNote: '',
      priceBookName: 'Bảng giá chung',
      productCode: 'SP000004',
      productName: 'Sản phẩm C',
      quantity: 10,
      price: 75000,
      discount: 20000,
      discountRatio: 0,
      lineTotal: 550000,
      productNote: '',
      invoiceDiscount: 50000,
      invoiceDiscountRatio: 0,
      totalAmount: 550000,
      grandTotal: 500000,
      customerPaid: 300000,
      cashAmount: 0,
      transferAmount: 300000,
      cardAmount: 0,
      walletAmount: 0,
      pointAmount: 0,
      voucherAmount: 0,
      voucherCode: '',
      codAmount: 200000,
      description: '',
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return buffer;
  }
}
