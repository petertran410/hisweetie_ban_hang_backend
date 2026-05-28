import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreatePriceBookDto,
  UpdatePriceBookDto,
  PriceBookQueryDto,
  ApplicablePriceBooksDto,
  ProductPriceDto,
} from './dto';
import { AuditLogsService } from 'src/audit-logs/audit-logs.service';
import {
  getCategoryFromActionCode,
  getSeverityFromActionCode,
  renderAuditMessage,
} from 'src/audit-logs/audit-templates';

@Injectable()
export class PriceBooksService {
  constructor(
    private prisma: PrismaService,
    private auditLogsService: AuditLogsService,
  ) {}

  async findAll(query: PriceBookQueryDto) {
    const { page = 1, limit = 10, search, isActive, branchId } = query;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (search) {
      where.name = { contains: search, mode: 'insensitive' };
    }

    if (isActive !== undefined) {
      where.isActive = isActive;
    }

    if (branchId) {
      where.OR = [
        { isGlobal: true },
        { priceBookBranches: { some: { branchId } } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.priceBook.findMany({
        where,
        skip,
        take: limit,
        include: {
          priceBookDetails: {
            include: {
              product: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  basePrice: true,
                },
              },
            },
          },
          priceBookBranches: {
            include: {
              branch: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
          priceBookCustomerGroups: {
            include: {
              customerGroup: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
          priceBookCustomers: {
            include: {
              customer: {
                select: {
                  id: true,
                  name: true,
                  code: true,
                },
              },
            },
          },
          priceBookUsers: {
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.priceBook.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async findOne(id: number) {
    if (!id || isNaN(id) || id <= 0) {
      throw new BadRequestException(`Invalid price book ID: ${id}`);
    }

    const priceBook = await this.prisma.priceBook.findUnique({
      where: { id },
      include: {
        priceBookDetails: {
          include: {
            product: {
              select: {
                id: true,
                code: true,
                name: true,
                basePrice: true,
                images: true,
              },
            },
          },
        },
        priceBookBranches: {
          include: {
            branch: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        priceBookCustomerGroups: {
          include: {
            customerGroup: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        priceBookCustomers: {
          include: {
            customer: {
              select: {
                id: true,
                name: true,
                code: true,
              },
            },
          },
        },
        priceBookUsers: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });

    if (!priceBook) {
      throw new NotFoundException(`Price book with ID ${id} not found`);
    }

    return priceBook;
  }

  async create(dto: CreatePriceBookDto, userId?: number) {
    return this.prisma.$transaction(async (tx) => {
      const priceBook = await tx.priceBook.create({
        data: {
          name: dto.name,
          isActive: dto.isActive ?? true,
          isGlobal: dto.isGlobal ?? false,
          startDate: dto.startDate ? new Date(dto.startDate) : null,
          endDate: dto.endDate ? new Date(dto.endDate) : null,
          allowNonListedProducts: dto.allowNonListedProducts ?? true,
          warnNonListedProducts: dto.warnNonListedProducts ?? false,
          priority: dto.priority ?? 0,
          forAllCusGroup: dto.forAllCusGroup ?? false,
          forAllCustomer: dto.forAllCustomer ?? true,
          forAllUser: dto.forAllUser ?? false,
        },
      });

      if (dto.branches && dto.branches.length > 0) {
        const branchesData = await Promise.all(
          dto.branches.map(async (branchId) => {
            const branch = await tx.branch.findUnique({
              where: { id: branchId },
              select: { name: true },
            });
            return {
              priceBookId: priceBook.id,
              branchId,
              branchName: branch?.name || '',
            };
          }),
        );
        await tx.priceBookBranch.createMany({ data: branchesData });
      }

      if (dto.customerGroups && dto.customerGroups.length > 0) {
        const customerGroupsData = await Promise.all(
          dto.customerGroups.map(async (customerGroupId) => {
            const group = await tx.customerGroup.findUnique({
              where: { id: customerGroupId },
              select: { name: true },
            });
            return {
              priceBookId: priceBook.id,
              customerGroupId,
              customerGroupName: group?.name || '',
            };
          }),
        );
        await tx.priceBookCustomerGroup.createMany({
          data: customerGroupsData,
        });
      }

      if (dto.customers && dto.customers.length > 0) {
        const customersData = await Promise.all(
          dto.customers.map(async (customerId) => {
            const customer = await tx.customer.findUnique({
              where: { id: customerId },
              select: { name: true },
            });
            return {
              priceBookId: priceBook.id,
              customerId,
              customerName: customer?.name || '',
            };
          }),
        );
        await tx.priceBookCustomer.createMany({
          data: customersData,
        });
      }

      if (dto.users && dto.users.length > 0) {
        const usersData = await Promise.all(
          dto.users.map(async (userId) => {
            const user = await tx.user.findUnique({
              where: { id: userId },
              select: { name: true },
            });
            return {
              priceBookId: priceBook.id,
              userId,
              userName: user?.name || '',
            };
          }),
        );
        await tx.priceBookUser.createMany({ data: usersData });
      }

      const result = await tx.priceBook.findUnique({
        where: { id: priceBook.id },
        include: {
          priceBookDetails: {
            include: {
              product: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  basePrice: true,
                  images: true,
                },
              },
            },
          },
          priceBookBranches: {
            include: {
              branch: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
          priceBookCustomerGroups: {
            include: {
              customerGroup: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
          priceBookCustomers: {
            include: {
              customer: {
                select: {
                  id: true,
                  name: true,
                  code: true,
                },
              },
            },
          },
          priceBookUsers: {
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
        },
      });

      if (userId && result) {
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true },
        });

        await this.auditLogsService.create({
          actionType: 'POST',
          actionCode: 'PRICE_BOOK_CREATE',
          entityType: 'price_books',
          entityId: result.id.toString(),
          entityCode: result.name,
          category: getCategoryFromActionCode('PRICE_BOOK_CREATE'),
          severity: getSeverityFromActionCode('PRICE_BOOK_CREATE'),
          snapshot: { name: result.name, isActive: result.isActive },
          message: renderAuditMessage('PRICE_BOOK_CREATE', {
            priceBookName: result.name,
          }),
          messageTemplate: 'PRICE_BOOK_CREATE',
          userId,
          userName: user?.name || user?.email || 'System',
        });
      }

      return result;
    });
  }

  async update(id: number, dto: UpdatePriceBookDto, userId?: number) {
    return this.prisma.$transaction(async (tx) => {
      await tx.priceBook.update({
        where: { id },
        data: {
          name: dto.name,
          isActive: dto.isActive,
          isGlobal: dto.isGlobal,
          startDate: dto.startDate ? new Date(dto.startDate) : undefined,
          endDate: dto.endDate ? new Date(dto.endDate) : undefined,
          allowNonListedProducts: dto.allowNonListedProducts,
          warnNonListedProducts: dto.warnNonListedProducts,
          priority: dto.priority,
          forAllCusGroup: dto.forAllCusGroup,
          forAllCustomer: dto.forAllCustomer,
          forAllUser: dto.forAllUser,
        },
      });

      if (dto.products !== undefined) {
        await tx.priceBookDetail.deleteMany({
          where: { priceBookId: id },
        });

        if (dto.products.length > 0) {
          await tx.priceBookDetail.createMany({
            data: dto.products.map((p) => ({
              priceBookId: id,
              productId: p.productId,
              price: p.price,
              isActive: p.isActive ?? true,
            })),
          });
        }
      }

      if (dto.branches !== undefined) {
        await tx.priceBookBranch.deleteMany({
          where: { priceBookId: id },
        });

        if (dto.branches.length > 0) {
          const branchesData = await Promise.all(
            dto.branches.map(async (branchId) => {
              const branch = await tx.branch.findUnique({
                where: { id: branchId },
                select: { name: true },
              });
              return {
                priceBookId: id,
                branchId,
                branchName: branch?.name || '',
              };
            }),
          );
          await tx.priceBookBranch.createMany({ data: branchesData });
        }
      }

      if (dto.customerGroups !== undefined) {
        await tx.priceBookCustomerGroup.deleteMany({
          where: { priceBookId: id },
        });

        if (dto.customerGroups.length > 0) {
          const customerGroupsData = await Promise.all(
            dto.customerGroups.map(async (customerGroupId) => {
              const group = await tx.customerGroup.findUnique({
                where: { id: customerGroupId },
                select: { name: true },
              });
              return {
                priceBookId: id,
                customerGroupId,
                customerGroupName: group?.name || '',
              };
            }),
          );
          await tx.priceBookCustomerGroup.createMany({
            data: customerGroupsData,
          });
        }
      }

      if (dto.customers !== undefined) {
        await tx.priceBookCustomer.deleteMany({
          where: { priceBookId: id },
        });

        if (dto.customers.length > 0) {
          const customersData = await Promise.all(
            dto.customers.map(async (customerId) => {
              const customer = await tx.customer.findUnique({
                where: { id: customerId },
                select: { name: true },
              });
              return {
                priceBookId: id,
                customerId,
                customerName: customer?.name || '',
              };
            }),
          );
          await tx.priceBookCustomer.createMany({
            data: customersData,
          });
        }
      }

      if (dto.users !== undefined) {
        await tx.priceBookUser.deleteMany({
          where: { priceBookId: id },
        });

        if (dto.users.length > 0) {
          const usersData = await Promise.all(
            dto.users.map(async (userId) => {
              const user = await tx.user.findUnique({
                where: { id: userId },
                select: { name: true },
              });
              return {
                priceBookId: id,
                userId,
                userName: user?.name || '',
              };
            }),
          );
          await tx.priceBookUser.createMany({ data: usersData });
        }
      }

      if (userId) {
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true },
        });
        const updatedPriceBook = await tx.priceBook.findUnique({
          where: { id },
        });

        await this.auditLogsService.create({
          actionType: 'PUT',
          actionCode: 'PRICE_BOOK_UPDATE',
          entityType: 'price_books',
          entityId: id.toString(),
          entityCode: updatedPriceBook?.name || '',
          category: getCategoryFromActionCode('PRICE_BOOK_UPDATE'),
          severity: getSeverityFromActionCode('PRICE_BOOK_UPDATE'),
          snapshot: {
            name: updatedPriceBook?.name,
            isActive: updatedPriceBook?.isActive,
          },
          message: renderAuditMessage('PRICE_BOOK_UPDATE', {
            priceBookName: updatedPriceBook?.name || '',
          }),
          messageTemplate: 'PRICE_BOOK_UPDATE',
          userId,
          userName: user?.name || user?.email || 'System',
        });
      }

      return this.findOne(id);
    });
  }

  async remove(id: number, userId?: number) {
    // THÊM userId?
    // THÊM: lấy thông tin trước khi xóa
    const priceBook = await this.prisma.priceBook.findUnique({ where: { id } });

    const result = await this.prisma.priceBook.delete({ where: { id } });

    // THÊM ĐOẠN NÀY sau delete
    if (userId && priceBook) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });

      await this.auditLogsService.create({
        actionType: 'DELETE',
        actionCode: 'PRICE_BOOK_DELETE',
        entityType: 'price_books',
        entityId: id.toString(),
        entityCode: priceBook.name,
        category: getCategoryFromActionCode('PRICE_BOOK_DELETE'),
        severity: getSeverityFromActionCode('PRICE_BOOK_DELETE'),
        snapshot: { name: priceBook.name, isActive: priceBook.isActive },
        message: renderAuditMessage('PRICE_BOOK_DELETE', {
          priceBookName: priceBook.name,
        }),
        messageTemplate: 'PRICE_BOOK_DELETE',
        userId,
        userName: user?.name || user?.email || 'System',
      });
    }

    return result;
  }

  async getApplicablePriceBooks(params: ApplicablePriceBooksDto) {
    const { branchId, customerId, userId, date } = params;
    const checkDate = date ? new Date(date) : new Date();

    const where: any = {
      isActive: true,
      AND: [
        { OR: [{ startDate: null }, { startDate: { lte: checkDate } }] },
        { OR: [{ endDate: null }, { endDate: { gte: checkDate } }] },
      ],
    };

    // Branch scope
    if (branchId) {
      where.AND.push({
        OR: [
          { isGlobal: true },
          { priceBookBranches: { some: { branchId } } },
        ],
      });
    }

    // Customer scope (gồm customer group + customer cụ thể)
    if (customerId) {
      const customer = await this.prisma.customer.findUnique({
        where: { id: customerId },
        include: {
          customerGroupDetails: {
            select: { customerGroupId: true },
          },
        },
      });

      if (customer) {
        const groupIds = customer.customerGroupDetails.map(
          (g) => g.customerGroupId,
        );

        // Customer group scope
        const cgConditions: any[] = [{ forAllCusGroup: true }];
        if (groupIds.length > 0) {
          cgConditions.push({
            priceBookCustomerGroups: {
              some: { customerGroupId: { in: groupIds } },
            },
          });
        }
        where.AND.push({ OR: cgConditions });

        // Customer cụ thể scope
        where.AND.push({
          OR: [
            { forAllCustomer: true },
            { priceBookCustomers: { some: { customerId } } },
          ],
        });
      }
    } else {
      // Không có customerId → chỉ hiện bảng giá forAllCustomer=true
      where.AND.push({ forAllCustomer: true });
    }

    // User scope
    if (userId) {
      where.AND.push({
        OR: [
          { forAllUser: true },
          { priceBookUsers: { some: { userId } } },
        ],
      });
    }

    const priceBooks = await this.prisma.priceBook.findMany({
      where,
      include: {
        priceBookDetails: {
          where: { isActive: true },
          include: {
            product: {
              select: {
                id: true,
                code: true,
                name: true,
                basePrice: true,
              },
            },
          },
        },
        priceBookBranches: true,
        priceBookCustomerGroups: true,
        priceBookCustomers: true,
        priceBookUsers: true,
      },
      orderBy: { priority: 'desc' },
    });

    return priceBooks;
  }

  async getPriceForProduct(params: ProductPriceDto) {
    const { productId, branchId, customerId, userId, priceBookId } = params;

    if (priceBookId && priceBookId > 0) {
      const detail = await this.prisma.priceBookDetail.findUnique({
        where: { priceBookId_productId: { priceBookId, productId } },
        include: {
          priceBook: {
            select: {
              id: true,
              name: true,
              allowNonListedProducts: true,
              warnNonListedProducts: true,
            },
          },
          product: { select: { basePrice: true } },
        },
      });

      if (detail && detail.isActive) {
        return {
          priceBookId: detail.priceBook.id,
          priceBookName: detail.priceBook.name,
          price: Number(detail.price),
          allowNonListedProducts: detail.priceBook.allowNonListedProducts,
          warnNonListedProducts: detail.priceBook.warnNonListedProducts,
          originalPrice: Number(detail.product.basePrice),
        };
      }

      // Sản phẩm không có trong bảng giá được chọn → trả về basePrice
      const product = await this.prisma.product.findUnique({
        where: { id: productId },
        select: { basePrice: true },
      });

      return {
        priceBookId: null,
        priceBookName: null,
        price: product ? Number(product.basePrice) : 0,
        allowNonListedProducts: true,
        warnNonListedProducts: false,
        originalPrice: product ? Number(product.basePrice) : 0,
      };
    }

    const priceBooks = await this.getApplicablePriceBooks({
      branchId,
      customerId,
      userId,
    });

    for (const priceBook of priceBooks) {
      const detail = priceBook.priceBookDetails.find(
        (d) => d.productId === productId && d.isActive,
      );

      if (detail) {
        return {
          priceBookId: priceBook.id,
          priceBookName: priceBook.name,
          price: Number(detail.price),
          allowNonListedProducts: priceBook.allowNonListedProducts,
          warnNonListedProducts: priceBook.warnNonListedProducts,
          originalPrice: Number(detail.product.basePrice),
        };
      }
    }

    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { basePrice: true },
    });

    return {
      priceBookId: null,
      priceBookName: null,
      price: product ? Number(product.basePrice) : 0,
      allowNonListedProducts: true,
      warnNonListedProducts: false,
      originalPrice: product ? Number(product.basePrice) : 0,
    };
  }

  async getProductsByPriceBook(priceBookId: number, searchQuery?: string) {
    const where: any = {
      priceBookId,
      isActive: true,
    };

    if (searchQuery) {
      where.product = {
        OR: [
          { code: { contains: searchQuery, mode: 'insensitive' } },
          { name: { contains: searchQuery, mode: 'insensitive' } },
        ],
      };
    }

    const priceBookDetails = await this.prisma.priceBookDetail.findMany({
      where,
      include: {
        product: {
          select: {
            id: true,
            code: true,
            name: true,
            basePrice: true,
            unit: true,
            images: true,
            inventories: {
              select: {
                onHand: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Tính tổng tồn kho từ tất cả chi nhánh
    return priceBookDetails.map((detail) => ({
      ...detail,
      product: {
        ...detail.product,
        totalStock: detail.product.inventories.reduce(
          (sum, inv) => sum + Number(inv.onHand),
          0,
        ),
        inventories: undefined, // Remove để không expose ra ngoài
      },
    }));
  }

  async addProductsToPriceBook(
    priceBookId: number,
    products: { productId: number; price: number }[],
    userId?: number,
  ) {
    if (!priceBookId || isNaN(priceBookId) || priceBookId <= 0) {
      throw new BadRequestException(`Invalid price book ID: ${priceBookId}`);
    }

    if (!products || products.length === 0) {
      throw new BadRequestException('Products array cannot be empty');
    }

    return this.prisma.$transaction(async (tx) => {
      const priceBook = await tx.priceBook.findUnique({
        where: { id: priceBookId },
      });

      if (!priceBook) {
        throw new NotFoundException(
          `Price book with ID ${priceBookId} not found`,
        );
      }

      const existingDetails = await tx.priceBookDetail.findMany({
        where: {
          priceBookId,
          productId: { in: products.map((p) => p.productId) },
        },
      });

      const existingProductIds = new Set(
        existingDetails.map((d) => d.productId),
      );

      const newProducts = products.filter(
        (p) => !existingProductIds.has(p.productId),
      );

      if (newProducts.length > 0) {
        await tx.priceBookDetail.createMany({
          data: newProducts.map((p) => ({
            priceBookId,
            productId: p.productId,
            price: p.price,
            isActive: true,
          })),
        });
      }

      if (userId && newProducts.length > 0) {
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true },
        });

        await this.auditLogsService.create({
          actionType: 'POST',
          actionCode: 'PRICE_BOOK_ADD_PRODUCTS',
          entityType: 'price_books',
          entityId: priceBookId.toString(),
          entityCode: priceBook.name,
          category: getCategoryFromActionCode('PRICE_BOOK_ADD_PRODUCTS'),
          severity: getSeverityFromActionCode('PRICE_BOOK_ADD_PRODUCTS'),
          snapshot: {
            priceBookName: priceBook.name,
            addedCount: newProducts.length,
          },
          message: renderAuditMessage('PRICE_BOOK_ADD_PRODUCTS', {
            productCount: newProducts.length,
            priceBookName: priceBook.name,
          }),
          messageTemplate: 'PRICE_BOOK_ADD_PRODUCTS',
          userId,
          userName: user?.name || user?.email || 'System',
        });
      }

      return this.findOne(priceBookId);
    });
  }

  async removeProductsFromPriceBook(
    priceBookId: number,
    productIds: number[],
    userId?: number,
  ) {
    if (!priceBookId || isNaN(priceBookId) || priceBookId <= 0) {
      throw new BadRequestException(`Invalid price book ID: ${priceBookId}`);
    }

    if (!productIds || productIds.length === 0) {
      throw new BadRequestException('Product IDs array cannot be empty');
    }

    await this.prisma.priceBookDetail.deleteMany({
      where: { priceBookId, productId: { in: productIds } },
    });

    if (userId) {
      const [user, priceBook] = await Promise.all([
        this.prisma.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true },
        }),
        this.prisma.priceBook.findUnique({
          where: { id: priceBookId },
          select: { name: true },
        }),
      ]);

      await this.auditLogsService.create({
        actionType: 'DELETE',
        actionCode: 'PRICE_BOOK_REMOVE_PRODUCTS',
        entityType: 'price_books',
        entityId: priceBookId.toString(),
        entityCode: priceBook?.name || '',
        category: getCategoryFromActionCode('PRICE_BOOK_REMOVE_PRODUCTS'),
        severity: getSeverityFromActionCode('PRICE_BOOK_REMOVE_PRODUCTS'),
        snapshot: {
          priceBookName: priceBook?.name,
          removedCount: productIds.length,
        },
        message: renderAuditMessage('PRICE_BOOK_REMOVE_PRODUCTS', {
          productCount: productIds.length,
          priceBookName: priceBook?.name || '',
        }),
        messageTemplate: 'PRICE_BOOK_REMOVE_PRODUCTS',
        userId,
        userName: user?.name || user?.email || 'System',
      });
    }

    return this.findOne(priceBookId);
  }

  async updateProductPrice(
    priceBookId: number,
    productId: number,
    price: number,
    userId?: number,
  ) {
    if (!priceBookId || isNaN(priceBookId) || priceBookId <= 0) {
      throw new BadRequestException(`Invalid price book ID: ${priceBookId}`);
    }

    if (!productId || isNaN(productId) || productId <= 0) {
      throw new BadRequestException(`Invalid product ID: ${productId}`);
    }

    if (price < 0 || isNaN(price)) {
      throw new BadRequestException(`Invalid price: ${price}`);
    }

    const existingDetail = await this.prisma.priceBookDetail.findUnique({
      where: { priceBookId_productId: { priceBookId, productId } },
      select: { price: true, product: { select: { name: true } } },
    });

    await this.prisma.priceBookDetail.updateMany({
      where: { priceBookId, productId },
      data: { price },
    });

    if (userId) {
      const [user, priceBook] = await Promise.all([
        this.prisma.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true },
        }),
        this.prisma.priceBook.findUnique({
          where: { id: priceBookId },
          select: { name: true },
        }),
      ]);

      await this.auditLogsService.create({
        actionType: 'PUT',
        actionCode: 'PRICE_BOOK_UPDATE_PRODUCT_PRICE',
        entityType: 'price_books',
        entityId: priceBookId.toString(),
        entityCode: priceBook?.name || '',
        category: getCategoryFromActionCode('PRICE_BOOK_UPDATE_PRODUCT_PRICE'),
        severity: getSeverityFromActionCode('PRICE_BOOK_UPDATE_PRODUCT_PRICE'),
        snapshot: {
          priceBookName: priceBook?.name,
          productName: existingDetail?.product?.name,
          oldPrice: Number(existingDetail?.price ?? 0),
          newPrice: price,
        },
        message: renderAuditMessage('PRICE_BOOK_UPDATE_PRODUCT_PRICE', {
          productName: existingDetail?.product?.name || `ID:${productId}`,
          priceBookName: priceBook?.name || '',
          oldPrice: Number(existingDetail?.price ?? 0),
          newPrice: price,
        }),
        messageTemplate: 'PRICE_BOOK_UPDATE_PRODUCT_PRICE',
        userId,
        userName: user?.name || user?.email || 'System',
      });
    }

    return this.findOne(priceBookId);
  }

  async getProductsWithMultiplePrices(
    priceBookIds: number[],
    searchQuery?: string,
    categoryIds?: string,
    branchId?: number,
    page: number = 1,
    limit: number = 15,
    extraFilters?: {
      parentName?: string;
      middleName?: string;
      childName?: string;
      stockStatus?: string;
    },
  ) {
    const where: any = {
      isActive: true,
    };

    if (searchQuery) {
      where.OR = [
        { code: { contains: searchQuery, mode: 'insensitive' } },
        { name: { contains: searchQuery, mode: 'insensitive' } },
      ];
    }

    if (categoryIds) {
      const categoryIdArray = categoryIds
        .split(',')
        .map((id) => parseInt(id.trim(), 10))
        .filter((id) => !isNaN(id));

      if (categoryIdArray.length > 0) {
        where.categoryId = { in: categoryIdArray };
      }
    }

    if (extraFilters?.parentName) where.parentName = extraFilters.parentName;
    if (extraFilters?.middleName) where.middleName = extraFilters.middleName;
    if (extraFilters?.childName) where.childName = extraFilters.childName;

    if (extraFilters?.stockStatus === 'instock') {
      where.inventories = { some: { onHand: { gt: 0 } } };
    } else if (extraFilters?.stockStatus === 'outstock') {
      where.inventories = { every: { onHand: { lte: 0 } } };
    }

    const skip = (page - 1) * limit;

    // Bao gồm cả Bảng giá chung (id=0) chỉ để JOIN priceBookDetails trả về,
    // nhưng count rank chỉ tính các bảng giá thật (id > 0)
    const realPriceBookIds = (priceBookIds || []).filter((id) => id > 0);

    const fullSelect = {
      id: true,
      code: true,
      name: true,
      basePrice: true,
      unit: true,
      inventories: branchId
        ? {
            where: { branchId },
            select: { onHand: true, cost: true, branchId: true },
          }
        : { select: { onHand: true, cost: true, branchId: true } },
      priceBookDetails: {
        where: {
          priceBookId: { in: priceBookIds },
          isActive: true,
        },
        select: {
          priceBookId: true,
          price: true,
        },
      },
    } as const;

    let products: any[] = [];
    let total = 0;

    if (realPriceBookIds.length > 0) {
      // Đếm số bảng giá (trong realPriceBookIds) mà mỗi sản phẩm xuất hiện
      const grouped = await this.prisma.priceBookDetail.groupBy({
        by: ['productId'],
        where: {
          priceBookId: { in: realPriceBookIds },
          isActive: true,
        },
        _count: { productId: true },
      });
      const matchCountMap = new Map<number, number>();
      grouped.forEach((g) =>
        matchCountMap.set(g.productId, g._count.productId),
      );
      const matchedIds = Array.from(matchCountMap.keys());

      // Lấy in-products thoả where, kèm createdAt để tie-break
      const inProducts = matchedIds.length
        ? await this.prisma.product.findMany({
            where: { ...where, id: { in: matchedIds } },
            select: { id: true, createdAt: true },
          })
        : [];

      // Sort: rank desc (số bảng giá khớp giảm dần), tie-break createdAt desc
      inProducts.sort((a, b) => {
        const ca = matchCountMap.get(a.id) || 0;
        const cb = matchCountMap.get(b.id) || 0;
        if (cb !== ca) return cb - ca;
        return b.createdAt.getTime() - a.createdAt.getTime();
      });

      const totalIn = inProducts.length;
      const outWhere = matchedIds.length
        ? { ...where, id: { notIn: matchedIds } }
        : where;
      const totalOut = await this.prisma.product.count({ where: outWhere });
      total = totalIn + totalOut;

      // Phân trang xuyên 2 nhóm: phần "in" trước (đã sort theo rank), "out" sau
      let inIdsWindow: number[] = [];
      let outSkip = 0;
      let outTake = 0;

      if (skip + limit <= totalIn) {
        inIdsWindow = inProducts.slice(skip, skip + limit).map((p) => p.id);
      } else if (skip >= totalIn) {
        outSkip = skip - totalIn;
        outTake = limit;
      } else {
        inIdsWindow = inProducts.slice(skip).map((p) => p.id);
        outTake = limit - inIdsWindow.length;
      }

      // Fetch in-products với full select rồi giữ đúng thứ tự rank
      let inResults: any[] = [];
      if (inIdsWindow.length > 0) {
        const fetched = await this.prisma.product.findMany({
          where: { id: { in: inIdsWindow } },
          select: fullSelect,
        });
        const fetchedMap = new Map(fetched.map((p) => [p.id, p]));
        inResults = inIdsWindow
          .map((id) => fetchedMap.get(id))
          .filter(Boolean) as any[];
      }

      // Fetch out-products với full select
      let outResults: any[] = [];
      if (outTake > 0) {
        outResults = await this.prisma.product.findMany({
          where: outWhere,
          select: fullSelect,
          orderBy: { createdAt: 'desc' },
          skip: outSkip,
          take: outTake,
        });
      }

      products = [...inResults, ...outResults];
    } else {
      // Không có bảng giá thật được chọn → fallback list thường
      const [list, count] = await Promise.all([
        this.prisma.product.findMany({
          where,
          skip,
          take: limit,
          select: fullSelect,
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.product.count({ where }),
      ]);
      products = list;
      total = count;
    }

    const data = products.map((product) => {
      const prices: Record<number, number> = {};
      product.priceBookDetails.forEach((detail: any) => {
        prices[detail.priceBookId] = Number(detail.price);
      });

      return {
        id: product.id,
        code: product.code,
        name: product.name,
        basePrice: Number(product.basePrice),
        unit: product.unit,
        prices,
        stockQuantity: product.inventories.reduce(
          (sum: number, inv: any) => sum + Number(inv.onHand),
          0,
        ),
        inventories: product.inventories,
      };
    });

    return { data, total, page, limit };
  }
}
