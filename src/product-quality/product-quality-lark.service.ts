import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as https from 'https';
import { PrismaService } from '../prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { QUALITY_STATUS, CODE_PREFIX } from './product-quality.service';
import { LarkImportDto } from './dto/lark-import.dto';

interface LarkAttachmentItem {
  file_token: string;
  name?: string;
  size?: number;
  type?: string;
  url?: string;
  tmp_url?: string;
}

interface ClassifiedAttachment {
  item: LarkAttachmentItem;
  kind: 'PROOF_IMAGE' | 'PROOF_VIDEO' | 'COMPLETION_PROOF';
  department?: string;
}

export interface LarkSyncResult {
  totalFetched: number;
  importedCount: number;
  updatedCount: number;
  skippedCount: number;
  matchedCustomers: number;
  matchedProducts: number;
  matchedInvoices: number;
  dryRun: boolean;
  mediaStats: {
    totalDiscovered: number;
    downloaded: number;
    skippedExisting: number;
    failed: number;
  };
  sample: any[];
}

@Injectable()
export class ProductQualityLarkService {
  private readonly logger = new Logger(ProductQualityLarkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly uploadService: UploadService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  /**
   * Lấy tenant_access_token từ Lark OpenAPI
   */
  async getTenantAccessToken(appId?: string, appSecret?: string): Promise<string> {
    const resolvedAppId = appId || this.config.get<string>('LARK_APP_ID');
    const resolvedAppSecret = appSecret || this.config.get<string>('LARK_APP_SECRET');

    if (!resolvedAppId || !resolvedAppSecret) {
      throw new BadRequestException('LARK_APP_ID hoặc LARK_APP_SECRET chưa được cấu hình');
    }

    const payload = JSON.stringify({ app_id: resolvedAppId, app_secret: resolvedAppSecret });

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'open.larksuite.com',
          path: '/open-apis/auth/v3/tenant_access_token/internal',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try {
              const body = JSON.parse(data);
              if (body.code === 0 && body.tenant_access_token) {
                resolve(body.tenant_access_token);
              } else {
                reject(new Error(body.msg || 'Auth Lark thất bại'));
              }
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  /**
   * Đọc danh sách các trường trong bảng để nhận diện các cột attachment
   */
  async fetchTableFields(
    baseToken: string,
    tableId: string,
    token: string,
  ): Promise<Array<{ id: string; name: string; type: number }>> {
    return new Promise((resolve) => {
      https.get(
        `https://open.larksuite.com/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/fields`,
        { headers: { Authorization: `Bearer ${token}` } },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(d);
              resolve(parsed.data?.items || []);
            } catch {
              resolve([]);
            }
          });
        },
      ).on('error', () => resolve([]));
    });
  }

  /**
   * Phân loại mục đính kèm theo tên trường trên LarkBase
   */
  classifyAttachment(
    fieldName: string,
    item: LarkAttachmentItem,
  ): ClassifiedAttachment {
    const normName = (fieldName || '').toLowerCase();
    const isVideo = normName.includes('video') || (item.type || '').startsWith('video');

    if (isVideo) {
      return { item, kind: 'PROOF_VIDEO' };
    }

    if (normName.includes('hoàn thành') || normName.includes('hoan thanh')) {
      let department = 'Kho + Logistics';
      if (normName.includes('kinh doanh')) department = 'Kinh Doanh';
      else if (normName.includes('kế toán') || normName.includes('ke toan')) department = 'Kế Toán Kho';
      else if (normName.includes('thu mua')) department = 'Thu Mua';
      return { item, kind: 'COMPLETION_PROOF', department };
    }

    return { item, kind: 'PROOF_IMAGE' };
  }

  /**
   * Tải file nhị phân từ URL của Lark
   */
  async downloadLarkMediaBuffer(
    fileUrl: string,
    token: string,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const req = https.get(
        fileUrl,
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 45000,
        },
        (res) => {
          if (res.statusCode !== 200) {
            return reject(new Error(`Tải file từ Lark thất bại (status ${res.statusCode})`));
          }
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Tải file từ Lark quá thời gian (timeout)'));
      });
    });
  }

  /**
   * Đọc toàn bộ các bản ghi theo trang (page_size: 500)
   */
  async fetchAllLarkRecords(
    baseToken: string,
    tableId: string,
    token: string,
    maxLimit?: number,
  ): Promise<any[]> {
    const all: any[] = [];
    let pageToken: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const pageSize = Math.min(500, maxLimit ? maxLimit - all.length : 500);
      if (pageSize <= 0) break;

      const qs = new URLSearchParams({
        page_size: String(pageSize),
        automatic_fields: 'true',
      });
      if (pageToken) qs.set('page_token', pageToken);

      const res: any = await new Promise((resolve, reject) => {
        const req = https.request(
          {
            hostname: 'open.larksuite.com',
            path: `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records?${qs.toString()}`,
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
          },
          (response) => {
            let d = '';
            response.on('data', (c) => (d += c));
            response.on('end', () => {
              try {
                resolve(JSON.parse(d));
              } catch (err) {
                reject(err);
              }
            });
          },
        );
        req.on('error', reject);
        req.end();
      });

      if (res.code !== 0) {
        this.logger.error(`Lark API error: ${res.msg}`);
        break;
      }

      const items = res.data?.items || [];
      all.push(...items);

      hasMore = res.data?.has_more || false;
      pageToken = res.data?.page_token;

      if (maxLimit && all.length >= maxLimit) break;
    }

    return all;
  }

  /**
   * Thực hiện đồng bộ từ LarkBase:
   * - dto.downloadMedia = false: Đồng bộ cực nhanh 1057 records vào DB, bỏ qua hình.
   * - dto.downloadMedia = true: Đồng bộ records + tải toàn bộ hình ảnh về uploads/product-quality/.
   */
  async sync(dto: LarkImportDto, userId: number): Promise<LarkSyncResult> {
    const baseToken = dto.baseToken || 'Vx4hb0o0Va3S1RsvbpGl4imYgYc';
    const tableId = dto.tableId || 'tblF032Qb8D2dcyd';

    const token = await this.getTenantAccessToken();
    const records = await this.fetchAllLarkRecords(baseToken, tableId, token, dto.limit);

    this.logger.log(`Đã đọc ${records.length} bản ghi từ LarkBase ${baseToken}/${tableId}`);

    // Pre-load các bảng liên quan để map id
    const [customers, products, invoices, users, branches] = await Promise.all([
      this.prisma.customer.findMany({ select: { id: true, code: true, name: true, larkRecordId: true } }),
      this.prisma.product.findMany({ select: { id: true, code: true, name: true, unit: true, larkRecordId: true } }),
      this.prisma.invoice.findMany({ select: { id: true, code: true } }),
      this.prisma.user.findMany({ select: { id: true, name: true, larkUserId: true } }),
      this.prisma.branch.findMany({ select: { id: true, name: true } }),
    ]);

    const customerByLarkId = new Map<string, typeof customers[0]>();
    const customerByName = new Map<string, typeof customers[0]>();
    for (const c of customers) {
      if (c.larkRecordId) customerByLarkId.set(c.larkRecordId, c);
      if (c.name) customerByName.set(c.name.trim().toLowerCase(), c);
    }

    const productByLarkId = new Map<string, typeof products[0]>();
    const productByCode = new Map<string, typeof products[0]>();
    for (const p of products) {
      if (p.larkRecordId) productByLarkId.set(p.larkRecordId, p);
      if (p.code) productByCode.set(p.code.trim().toUpperCase(), p);
    }

    const invoiceByCode = new Map<string, typeof invoices[0]>();
    for (const inv of invoices) {
      invoiceByCode.set(inv.code.trim().toUpperCase(), inv);
    }

    const userByLarkId = new Map<string, typeof users[0]>();
    const userByName = new Map<string, typeof users[0]>();
    for (const u of users) {
      if (u.larkUserId) userByLarkId.set(u.larkUserId, u);
      if (u.name) userByName.set(u.name.trim().toLowerCase(), u);
    }

    const branchByName = new Map<string, typeof branches[0]>();
    for (const b of branches) {
      branchByName.set(b.name.trim().toLowerCase(), b);
    }

    // Lấy số thứ tự phiếu tiếp theo
    const last = await this.prisma.productQualityTicket.findFirst({
      where: { code: { startsWith: CODE_PREFIX } },
      orderBy: { id: 'desc' },
      select: { code: true },
    });
    let nextNum = 1;
    if (last) {
      const parsed = parseInt(last.code.replace(CODE_PREFIX, ''), 10);
      if (!isNaN(parsed)) nextNum = parsed + 1;
    }

    let matchedCustomers = 0;
    let matchedProducts = 0;
    let matchedInvoices = 0;
    let importedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;

    let totalDiscoveredMedia = 0;
    let downloadedMedia = 0;
    let skippedExistingMedia = 0;
    let failedMedia = 0;

    const itemsPreview: any[] = [];

    for (const rec of records) {
      const f = rec.fields || {};

      // 1. Khách hàng
      const customerLink = this.extractLinkRecord(f['Tên Khách Hàng']);
      let matchedCustomer = customerLink?.id ? customerByLarkId.get(customerLink.id) : undefined;
      if (!matchedCustomer && customerLink?.text) {
        matchedCustomer = customerByName.get(customerLink.text.trim().toLowerCase());
      }
      if (matchedCustomer) matchedCustomers++;

      // 2. Sản phẩm
      const productLink = this.extractLinkRecord(f['Tên Sản Phẩm']);
      let matchedProduct = productLink?.id ? productByLarkId.get(productLink.id) : undefined;
      if (!matchedProduct && productLink?.text) {
        const codeMatch = productLink.text.match(/SP\d{6}|[A-Z0-9]{5,15}/i);
        if (codeMatch) {
          matchedProduct = productByCode.get(codeMatch[0].toUpperCase());
        }
      }
      if (matchedProduct) matchedProducts++;

      // 3. Hóa đơn
      const invoiceLink = this.extractLinkRecord(f['Hóa Đơn']);
      const invoiceCode = invoiceLink?.text?.trim().toUpperCase();
      const matchedInvoice = invoiceCode ? invoiceByCode.get(invoiceCode) : undefined;
      if (matchedInvoice) matchedInvoices++;

      // 4. Chi nhánh
      const rawKho =
        this.extractText(f['Kho']) ||
        this.extractText(f['Kho / Chi nhánh']) ||
        this.extractText(f['Chi Nhánh']) ||
        this.extractText(f['Chi nhánh']) ||
        this.extractText(f['Kho Hàng']) ||
        this.extractText(f['Kho hàng']) ||
        this.extractText(f['Địa Điểm']) ||
        this.extractText(f['Địa điểm']);
      let matchedBranch: typeof branches[0] | undefined;
      if (rawKho) {
        const normK = rawKho.toLowerCase();
        if (normK.includes('hà nội') || normK.includes('ha noi') || normK.includes('hn')) {
          matchedBranch = branchByName.get('kho hà nội') || branches.find((b) => b.id === 6);
        } else if (normK.includes('sài gòn') || normK.includes('sai gon') || normK.includes('sg') || normK.includes('hcm')) {
          matchedBranch = branchByName.get('kho sài gòn') || branches.find((b) => b.id === 1);
        } else {
          matchedBranch = branchByName.get(normK);
        }
      }

      // 5. Người phụ trách / Người quyết định
      const rawDecisionMaker = this.extractUser(f['Người Quyết Định']);
      let matchedDecisionMaker = rawDecisionMaker?.id ? userByLarkId.get(rawDecisionMaker.id) : undefined;
      if (!matchedDecisionMaker && rawDecisionMaker?.name) {
        matchedDecisionMaker = userByName.get(rawDecisionMaker.name.trim().toLowerCase());
      }

      // 6. Trạng thái & SLA
      const rawStatus = this.extractText(f['Trạng Thái Sự Cố']) || 'Mới';
      const status = this.mapLarkStatus(rawStatus);

      const createdAt = f['Ngày tạo'] ? new Date(Number(f['Ngày tạo'])) : new Date(rec.created_time || Date.now());
      const handledAt = f['Ngày Có Xử Lý'] ? new Date(Number(f['Ngày Có Xử Lý'])) : undefined;
      const completedAt = f['Ngày Hoàn Thành'] ? new Date(Number(f['Ngày Hoàn Thành'])) : undefined;
      const dueAt = handledAt ? this.calcDueDate(handledAt, 5) : undefined;

      // 7. Bộ phận thực hiện & Task
      const assignedDepts = this.extractMultiSelect(f['Bộ Phận Thực Hiện']);
      const kdDone = !!f['Phòng Kinh Doanh'];
      const khoDone = !!f['Kho + Logistics'];
      const ktDone = !!f['Kế Toán Kho'];
      const tmDone = !!f['Thu Mua'];

      // 8. Thu thập đính kèm từ các trường
      const recordAttachments: ClassifiedAttachment[] = [];
      for (const [colName, val] of Object.entries(f)) {
        if (Array.isArray(val) && val.length > 0 && val[0]?.file_token) {
          for (const att of val as LarkAttachmentItem[]) {
            if (att.file_token) {
              recordAttachments.push(this.classifyAttachment(colName, att));
            }
          }
        }
      }
      totalDiscoveredMedia += recordAttachments.length;

      const item = {
        sourceRecordId: rec.record_id,
        legacyCode: this.extractText(f['Mã Phiếu']) || rec.record_id,
        branchId: matchedBranch?.id,
        branchName: matchedBranch?.name || rawKho,
        customerId: matchedCustomer?.id,
        customerCode: matchedCustomer?.code,
        customerName: customerLink?.text || 'Khách hàng',
        productId: matchedProduct?.id,
        productCode: matchedProduct?.code,
        productName: productLink?.text || 'Sản phẩm',
        unit: this.extractText(f['Đơn Vị Tính']) || matchedProduct?.unit,
        sourceType: this.extractText(f['Nguồn Hàng']),
        quantity: Number(this.extractText(f['Số Lượng']) || 1),
        expiryDate: f['Hạn Sử Dụng'] ? new Date(Number(f['Hạn Sử Dụng'])) : undefined,
        reason: this.extractText(f['Nguyên Nhân']) || 'Sự cố phản ánh từ khách hàng',
        initialClassification: this.extractText(f['Phân Loại Sự Cố Ban Đầu']) || 'Chất Lượng Sản Phẩm',
        feedbackType: this.extractText(f['Loại phản hồi']) || 'Hàng Lỗi / Hỏng',
        severity: this.extractText(f['Mức Độ Nghiêm Trọng']),
        responsibilities: this.extractMultiSelect(f['Trách Nhiệm Thuộc Về']),
        factoryName: this.extractText(f['Nhà Máy Sản Xuất']),
        note: this.extractText(f['Ghi Chú']),
        invoiceId: matchedInvoice?.id,
        invoiceCode: invoiceCode || undefined,
        decisionMakerId: matchedDecisionMaker?.id,
        decisionMakerName: matchedDecisionMaker?.name || rawDecisionMaker?.name,
        handlingDirection: this.extractText(f['Hướng Xử Lý']),
        assignedDepartments: assignedDepts,
        status,
        isCompleted: status === QUALITY_STATUS.COMPLETED,
        handledAt,
        dueAt,
        completedAt,
        createdAt,
        attachmentCount: recordAttachments.length,
        tasks: [
          { dept: 'Kinh Doanh', isCompleted: kdDone, feedback: this.extractText(f['Phòng Kinh Doanh Phản Hồi ( Nếu có)']) },
          { dept: 'Kho + Logistics', isCompleted: khoDone, feedback: this.extractText(f['Kho Phản Hồi (Nếu Có)']) },
          { dept: 'Kế Toán Kho', isCompleted: ktDone, feedback: this.extractText(f['Kế Toán Phản Hồi ( Nếu Có)']) },
          { dept: 'Thu Mua', isCompleted: tmDone, feedback: this.extractText(f['Thu Mua Phản Hồi (Nếu Có)']) },
        ].filter((t) => assignedDepts.includes(t.dept) || t.isCompleted || !!t.feedback),
      };

      itemsPreview.push(item);

      if (!dto.dryRun) {
        try {
          // Đối chiếu ticket cũ
          let existing = await this.prisma.productQualityTicket.findUnique({
            where: { sourceRecordId: rec.record_id },
            include: { attachments: { select: { larkFileToken: true } } },
          });

          if (!existing && item.legacyCode) {
            existing = await this.prisma.productQualityTicket.findFirst({
              where: {
                OR: [
                  { legacyCode: item.legacyCode },
                  { code: item.legacyCode },
                ],
              },
              include: { attachments: { select: { larkFileToken: true } } },
            });
          }

          let savedTicketId: number;

          if (existing) {
            // Cập nhật ticket
            const updated = await this.prisma.productQualityTicket.update({
              where: { id: existing.id },
              data: {
                sourceRecordId: rec.record_id,
                branchId: item.branchId || existing.branchId,
                branchName: item.branchName || existing.branchName,
                customerId: item.customerId,
                customerCode: item.customerCode,
                customerName: item.customerName,
                productId: item.productId,
                productCode: item.productCode,
                productName: item.productName,
                unit: item.unit,
                sourceType: item.sourceType,
                quantity: item.quantity,
                expiryDate: item.expiryDate,
                reason: item.reason,
                initialClassification: item.initialClassification,
                feedbackType: item.feedbackType,
                severity: item.severity,
                responsibilities: item.responsibilities,
                factoryName: item.factoryName,
                note: item.note,
                invoiceId: item.invoiceId,
                invoiceCode: item.invoiceCode,
                decisionMakerId: item.decisionMakerId || existing.decisionMakerId,
                decisionMakerName: item.decisionMakerName || existing.decisionMakerName,
                handlingDirection: item.handlingDirection || existing.handlingDirection,
                assignedDepartments: item.assignedDepartments,
                status: item.status,
                isCompleted: item.isCompleted,
                handledAt: item.handledAt || existing.handledAt,
                dueAt: item.dueAt || existing.dueAt,
                completedAt: item.completedAt || existing.completedAt,
              },
            });
            savedTicketId = updated.id;
            updatedCount++;
          } else {
            // Tạo mới ticket
            const ticketCode = `${CODE_PREFIX}${String(nextNum++).padStart(6, '0')}`;
            const created = await this.prisma.productQualityTicket.create({
              data: {
                code: ticketCode,
                legacyCode: item.legacyCode,
                sourceRecordId: item.sourceRecordId,
                branchId: item.branchId,
                branchName: item.branchName,
                customerId: item.customerId,
                customerCode: item.customerCode,
                customerName: item.customerName,
                productId: item.productId,
                productCode: item.productCode,
                productName: item.productName,
                unit: item.unit,
                sourceType: item.sourceType,
                quantity: item.quantity,
                expiryDate: item.expiryDate,
                reason: item.reason,
                initialClassification: item.initialClassification,
                feedbackType: item.feedbackType,
                severity: item.severity,
                responsibilities: item.responsibilities,
                factoryName: item.factoryName,
                note: item.note,
                invoiceId: item.invoiceId,
                invoiceCode: item.invoiceCode,
                decisionMakerId: item.decisionMakerId,
                decisionMakerName: item.decisionMakerName,
                handlingDirection: item.handlingDirection,
                assignedDepartments: item.assignedDepartments,
                status: item.status,
                isCompleted: item.isCompleted,
                handledAt: item.handledAt,
                dueAt: item.dueAt,
                completedAt: item.completedAt,
                createdById: userId,
                createdAt: item.createdAt,
              },
            });
            savedTicketId = created.id;
            importedCount++;
          }

          // Upsert tasks cho các bộ phận
          for (const t of item.tasks) {
            await this.prisma.productQualityTask.upsert({
              where: {
                ticketId_department: {
                  ticketId: savedTicketId,
                  department: t.dept,
                },
              },
              create: {
                ticketId: savedTicketId,
                department: t.dept,
                isCompleted: t.isCompleted,
                feedback: t.feedback,
                completedAt: t.isCompleted ? item.completedAt || item.handledAt : null,
              },
              update: {
                isCompleted: t.isCompleted,
                feedback: t.feedback,
                completedAt: t.isCompleted ? item.completedAt || item.handledAt : null,
              },
            });
          }

          // Tải bổ sung hình ảnh nếu được yêu cầu
          if (dto.downloadMedia && recordAttachments.length > 0) {
            const existingTokens = new Set(
              (existing?.attachments || []).map((a) => a.larkFileToken).filter(Boolean),
            );

            for (const att of recordAttachments) {
              const fileToken = att.item.file_token;
              if (existingTokens.has(fileToken)) {
                skippedExistingMedia++;
                continue;
              }

              const downloadUrl = att.item.url || att.item.tmp_url;
              if (!downloadUrl) {
                failedMedia++;
                continue;
              }

              try {
                const buffer = await this.downloadLarkMediaBuffer(downloadUrl, token);
                const originalName = att.item.name || `${fileToken}.jpg`;
                const mimeType = att.item.type || 'image/jpeg';

                // Lưu vào uploads/product-quality/
                const saved = await this.uploadService.saveFile(
                  buffer,
                  originalName,
                  mimeType,
                  'product-quality',
                );

                await this.prisma.productQualityAttachment.create({
                  data: {
                    ticketId: savedTicketId,
                    department: att.department,
                    kind: att.kind,
                    filename: saved.filename,
                    originalName,
                    url: saved.url,
                    mimetype: mimeType,
                    size: saved.size,
                    larkFileToken: fileToken,
                    createdById: userId,
                  },
                });

                existingTokens.add(fileToken);
                downloadedMedia++;

                // Nghỉ ngắn để không chạm rate limit 5 QPS của Lark
                await new Promise((r) => setTimeout(r, 120));
              } catch (err: any) {
                this.logger.warn(`Lỗi tải đính kèm ${fileToken}: ${err?.message}`);
                failedMedia++;
              }
            }
          }
        } catch (err: any) {
          this.logger.error(`Lỗi xử lý record ${rec.record_id}: ${err?.message}`);
          skippedCount++;
        }
      }
    }

    if (!dto.dryRun && (importedCount > 0 || updatedCount > 0)) {
      void this.auditLogsService.create({
        actionType: 'POST',
        actionCode: 'product_quality.sync_lark',
        message: `Đồng bộ LarkBase: ${importedCount} tạo mới, ${updatedCount} cập nhật, ${downloadedMedia} ảnh tải về`,
        entityType: 'product_quality_ticket',
        userId,
        userName: 'Admin',
        category: 'Sản phẩm',
        severity: 'info',
        snapshot: {
          totalFetched: records.length,
          importedCount,
          updatedCount,
          downloadedMedia,
          skippedExistingMedia,
          failedMedia,
        },
      });
    }

    return {
      totalFetched: records.length,
      importedCount: dto.dryRun ? 0 : importedCount,
      updatedCount: dto.dryRun ? 0 : updatedCount,
      skippedCount: dto.dryRun ? 0 : skippedCount,
      matchedCustomers,
      matchedProducts,
      matchedInvoices,
      dryRun: !!dto.dryRun,
      mediaStats: {
        totalDiscovered: totalDiscoveredMedia,
        downloaded: downloadedMedia,
        skippedExisting: skippedExistingMedia,
        failed: failedMedia,
      },
      sample: itemsPreview.slice(0, 10),
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────

  private calcDueDate(startDate: Date, days: number): Date {
    const d = new Date(startDate.getTime());
    d.setDate(d.getDate() + days);
    return d;
  }

  private mapLarkStatus(rawStatus: string): string {
    const s = (rawStatus || '').trim().toLowerCase();
    if (s.includes('hoàn thành') || s === 'done') return QUALITY_STATUS.COMPLETED;
    if (s.includes('khắc phục')) return QUALITY_STATUS.REMEDIATING;
    if (s.includes('đang xử lý')) return QUALITY_STATUS.IN_PROGRESS;
    if (s.includes('ended') || s.includes('dừng') || s.includes('hủy'))
      return QUALITY_STATUS.ENDED;
    return QUALITY_STATUS.NEW;
  }

  private extractText(v: any): string {
    if (v == null) return '';
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) {
      return v.map((item) => this.extractText(item)).filter(Boolean).join(' ');
    }
    if (typeof v === 'object') {
      return v.text || v.name || v.full_address || '';
    }
    return String(v).trim();
  }

  private extractMultiSelect(v: any): string[] {
    if (!v) return [];
    if (Array.isArray(v)) {
      return v.map((item) => (typeof item === 'string' ? item : item.name || item.text || '')).filter(Boolean);
    }
    if (typeof v === 'string') {
      return v.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return [];
  }

  private extractLinkRecord(v: any): { id?: string; text?: string } | null {
    if (!v) return null;
    if (Array.isArray(v) && v.length > 0) {
      const first = v[0];
      const id = first.record_ids?.[0] || first.id;
      const text = first.text || first.name || (Array.isArray(first.text_arr) ? first.text_arr[0] : '');
      return { id, text };
    }
    if (typeof v === 'object') {
      const id = v.record_ids?.[0] || v.id;
      const text = v.text || v.name;
      return { id, text };
    }
    return null;
  }

  private extractUser(v: any): { id?: string; name?: string } | null {
    if (!v) return null;
    if (Array.isArray(v) && v.length > 0) {
      const first = v[0];
      return { id: first.id, name: first.name };
    }
    if (typeof v === 'object') {
      return { id: v.id, name: v.name };
    }
    return null;
  }
}
