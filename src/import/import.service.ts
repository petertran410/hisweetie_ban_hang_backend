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

    // --- 1. Lấy branch info ---
    let branch: { id: number; name: string } | null = null;
    if (options.branchId) {
      branch = await this.prisma.branch.findUnique({
        where: { id: options.branchId },
        select: { id: true, name: true },
      });
    }
    if (!branch) {
      const firstBranch = await this.prisma.branch.findFirst({
        select: { id: true, name: true },
      });
      if (!firstBranch) {
        throw new BadRequestException('No branch found in system');
      }
      branch = firstBranch;
    }

    // --- 2. Parse rows ---
    const rawRows: any[] = [];
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber <= 1) return; // skip header

      const typeText = row.getCell(1).value?.toString()?.trim() || '';
      const categoryText = row.getCell(2).value?.toString()?.trim() || '';
      const code = row.getCell(3).value?.toString()?.trim() || '';
      const name = row.getCell(4).value?.toString()?.trim() || '';
      const tradeMarkName = row.getCell(5).value?.toString()?.trim() || '';
      const basePrice = this.parseNumber(row.getCell(6).value);
      const cost = this.parseNumber(row.getCell(7).value);
      const onHand = this.parseNumber(row.getCell(8).value);
      const minQuality = this.parseNumber(row.getCell(9).value);
      const maxQuality = this.parseNumber(row.getCell(10).value);
      const unit = row.getCell(11).value?.toString()?.trim() || '';
      const attributesText = row.getCell(12).value?.toString()?.trim() || '';
      const relatedCode = row.getCell(13).value?.toString()?.trim() || '';
      const imageUrls = row.getCell(14).value?.toString()?.trim() || '';
      const weight = this.parseNumber(row.getCell(15).value);
      const isDirectSale = row.getCell(16).value?.toString()?.trim() === '1';
      const description = row.getCell(17).value?.toString()?.trim() || '';
      const componentsText = row.getCell(18).value?.toString()?.trim() || '';

      if (!code || !name) return;

      rawRows.push({
        rowNumber,
        typeText,
        categoryText,
        code,
        name,
        tradeMarkName,
        basePrice,
        cost,
        onHand,
        minQuality,
        maxQuality,
        unit,
        attributesText,
        relatedCode,
        imageUrls,
        weight,
        isDirectSale,
        description,
        componentsText,
      });
    });

    if (rawRows.length === 0) {
      throw new BadRequestException('No valid data rows found');
    }

    // --- 3. Batch lookup: existing products, categories, trademarks ---
    const allCodes = rawRows.map((r) => r.code);
    const existingProducts = await this.prisma.product.findMany({
      where: { code: { in: allCodes } },
      select: { id: true, code: true },
    });
    const existingProductMap = new Map(
      existingProducts.map((p) => [p.code, p.id]),
    );

    // Lookup all categories
    const categoryCache = new Map<string, number>();
    const allCategories: {
      id: number;
      name: string;
      parentId: number | null;
    }[] = await this.prisma.category.findMany();

    // Lookup all trademarks
    const tradeMarkCache = new Map<string, number>();
    const allTradeMarks = await this.prisma.tradeMark.findMany({
      select: { id: true, name: true },
    });
    allTradeMarks.forEach((tm) =>
      tradeMarkCache.set(tm.name.toLowerCase(), tm.id),
    );

    // --- 4. Process each row ---
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

        const existingId = existingProductMap.get(row.code);

        if (existingId) {
          // --- UPDATE existing product ---
          const updateData: any = {
            name: row.name,
            type: productType,
            categoryId,
            tradeMarkId,
            basePrice: row.basePrice,
            unit: row.unit || undefined,
            weight: row.weight || undefined,
            isDirectSale: row.isDirectSale,
            attributesText: row.attributesText || undefined,
          };

          if (options.updateDescription) {
            updateData.description = row.description || null;
          }

          await this.prisma.product.update({
            where: { id: existingId },
            data: updateData,
          });

          // Update inventory
          await this.upsertInventory(
            existingId,
            row.code,
            row.name,
            branch,
            row,
            options,
          );

          // Update images
          if (row.imageUrls) {
            await this.syncProductImages(existingId, row.imageUrls);
          }

          // Update components (combo/manufacturing)
          if ((productType === 1 || productType === 4) && row.componentsText) {
            await this.syncProductComponents(existingId, row.componentsText);
          }

          updated.push({ code: row.code, id: existingId });
        } else {
          // --- CREATE new product ---
          const product = await this.prisma.product.create({
            data: {
              code: row.code,
              name: row.name,
              type: productType,
              parentName,
              middleName,
              childName,
              tradeMarkId,
              basePrice: row.basePrice,
              unit: row.unit || undefined,
              weight: row.weight || undefined,
              isDirectSale: row.isDirectSale,
              description: row.description || undefined,
              attributesText: row.attributesText || undefined,
            } as any,
          });

          existingProductMap.set(row.code, product.id);

          // Create inventory
          await this.prisma.inventory.create({
            data: {
              productId: product.id,
              productCode: row.code,
              productName: row.name,
              branchId: branch.id,
              branchName: branch.name,
              cost: row.cost,
              onHand: row.onHand,
              minQuality: row.minQuality,
              maxQuality: row.maxQuality,
            },
          });

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
    },
    options: { updateStock?: boolean; updateCost?: boolean },
  ) {
    const existing = await this.prisma.inventory.findUnique({
      where: { productId_branchId: { productId, branchId: branch.id } },
    });

    if (existing) {
      const updateData: any = {
        minQuality: row.minQuality,
        maxQuality: row.maxQuality,
      };
      if (options.updateStock) {
        updateData.onHand = row.onHand;
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
          minQuality: row.minQuality,
          maxQuality: row.maxQuality,
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

    // Delete old images and recreate
    await this.prisma.productImage.deleteMany({ where: { productId } });
    await this.prisma.productImage.createMany({
      data: urls.map((url) => ({ productId, image: url })),
    });
  }

  private async syncProductComponents(
    productId: number,
    componentsText: string,
  ) {
    // Format: "HH000023:1,HH000016:2"
    const parts = componentsText
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const components: { code: string; quantity: number }[] = [];

    for (const part of parts) {
      const [code, qty] = part.split(':');
      if (code && qty) {
        components.push({ code: code.trim(), quantity: parseFloat(qty) || 1 });
      }
    }

    if (components.length === 0) return;

    // Lookup component products
    const codes = components.map((c) => c.code);
    const products = await this.prisma.product.findMany({
      where: { code: { in: codes } },
      select: { id: true, code: true },
    });
    const productMap = new Map(products.map((p) => [p.code, p.id]));

    // Delete old components and recreate
    await this.prisma.productComponent.deleteMany({
      where: { comboProductId: productId },
    });

    const createData = components
      .filter((c) => productMap.has(c.code))
      .map((c) => ({
        comboProductId: productId,
        componentProductId: productMap.get(c.code)!,
        quantity: c.quantity,
      }));

    if (createData.length > 0) {
      await this.prisma.productComponent.createMany({ data: createData });
    }
  }

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

  async generateProductsTemplate() {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Products');

    worksheet.columns = [
      { header: 'Code', key: 'code', width: 15 },
      { header: 'Name', key: 'name', width: 30 },
      { header: 'Description', key: 'description', width: 40 },
      { header: 'Category ID', key: 'categoryId', width: 12 },
      { header: 'Variant ID', key: 'variantId', width: 12 },
      { header: 'Purchase Price', key: 'purchasePrice', width: 15 },
      { header: 'Retail Price', key: 'basePrice', width: 15 },
      { header: 'Collaborator Price', key: 'collaboratorPrice', width: 18 },
      { header: 'Stock Quantity', key: 'stockQuantity', width: 15 },
      { header: 'Min Stock Alert', key: 'minStockAlert', width: 15 },
      { header: 'Is Active', key: 'isActive', width: 10 },
    ];

    worksheet.addRow({
      code: 'SP001',
      name: 'Sample Product',
      description: 'Product description',
      categoryId: 1,
      variantId: 1,
      purchasePrice: 100000,
      basePrice: 150000,
      collaboratorPrice: 120000,
      stockQuantity: 100,
      minStockAlert: 10,
      isActive: 'true',
    });

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
}
