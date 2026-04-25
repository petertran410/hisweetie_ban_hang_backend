import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as ExcelJS from 'exceljs';

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
}
