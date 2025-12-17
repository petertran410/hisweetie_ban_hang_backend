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

@Injectable()
export class PriceBooksService {
  constructor(private prisma: PrismaService) {}

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
                  retailPrice: true,
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
                retailPrice: true,
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

  async create(dto: CreatePriceBookDto) {
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
                  retailPrice: true,
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

      return result;
    });
  }

  async update(id: number, dto: UpdatePriceBookDto) {
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

      return this.findOne(id);
    });
  }

  async remove(id: number) {
    return this.prisma.priceBook.delete({ where: { id } });
  }

  async getApplicablePriceBooks(params: ApplicablePriceBooksDto) {
    const { branchId, customerId, userId, date } = params;
    const checkDate = date ? new Date(date) : new Date();

    const where: any = {
      isActive: true,
      OR: [{ startDate: null }, { startDate: { lte: checkDate } }],
      AND: [
        {
          OR: [{ endDate: null }, { endDate: { gte: checkDate } }],
        },
      ],
    };

    const orConditions: any[] = [];

    if (branchId) {
      orConditions.push(
        { isGlobal: true },
        { priceBookBranches: { some: { branchId } } },
      );
    }

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

        if (groupIds.length > 0) {
          orConditions.push({
            priceBookCustomerGroups: {
              some: { customerGroupId: { in: groupIds } },
            },
          });
        }

        orConditions.push({ forAllCusGroup: true });
      }
    }

    if (userId) {
      orConditions.push(
        { priceBookUsers: { some: { userId } } },
        { forAllUser: true },
      );
    }

    if (orConditions.length > 0) {
      where.OR = orConditions;
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
                retailPrice: true,
              },
            },
          },
        },
        priceBookBranches: true,
        priceBookCustomerGroups: true,
        priceBookUsers: true,
      },
      orderBy: { priority: 'desc' },
    });

    return priceBooks;
  }

  async getPriceForProduct(params: ProductPriceDto) {
    const { productId, branchId, customerId, userId } = params;

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
          originalPrice: Number(detail.product.retailPrice),
        };
      }
    }

    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { retailPrice: true },
    });

    return {
      priceBookId: null,
      priceBookName: null,
      price: product ? Number(product.retailPrice) : 0,
      allowNonListedProducts: true,
      warnNonListedProducts: false,
      originalPrice: product ? Number(product.retailPrice) : 0,
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

    return this.prisma.priceBookDetail.findMany({
      where,
      include: {
        product: {
          select: {
            id: true,
            code: true,
            name: true,
            retailPrice: true,
            stockQuantity: true,
            unit: true,
            images: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async addProductsToPriceBook(
    priceBookId: number,
    products: { productId: number; price: number }[],
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

      return this.findOne(priceBookId);
    });
  }

  async removeProductsFromPriceBook(priceBookId: number, productIds: number[]) {
    if (!priceBookId || isNaN(priceBookId) || priceBookId <= 0) {
      throw new BadRequestException(`Invalid price book ID: ${priceBookId}`);
    }

    if (!productIds || productIds.length === 0) {
      throw new BadRequestException('Product IDs array cannot be empty');
    }

    await this.prisma.priceBookDetail.deleteMany({
      where: {
        priceBookId,
        productId: { in: productIds },
      },
    });

    return this.findOne(priceBookId);
  }

  async updateProductPrice(
    priceBookId: number,
    productId: number,
    price: number,
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

    await this.prisma.priceBookDetail.updateMany({
      where: {
        priceBookId,
        productId,
      },
      data: { price },
    });

    return this.findOne(priceBookId);
  }

  async getProductsWithMultiplePrices(
    priceBookIds: number[],
    searchQuery?: string,
    categoryId?: number,
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

    if (categoryId) {
      where.categoryId = categoryId;
    }

    const products = await this.prisma.product.findMany({
      where,
      select: {
        id: true,
        code: true,
        name: true,
        purchasePrice: true,
        retailPrice: true,
        stockQuantity: true,
        unit: true,
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
      },
      orderBy: { code: 'asc' },
    });

    return products.map((product) => {
      const priceMap: Record<number, number> = {};
      product.priceBookDetails.forEach((detail) => {
        priceMap[detail.priceBookId] = Number(detail.price);
      });

      return {
        id: product.id,
        code: product.code,
        name: product.name,
        purchasePrice: Number(product.purchasePrice),
        retailPrice: Number(product.retailPrice),
        stockQuantity: product.stockQuantity,
        unit: product.unit,
        prices: priceMap,
      };
    });
  }
}
