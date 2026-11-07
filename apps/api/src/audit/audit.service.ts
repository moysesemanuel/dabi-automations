import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.module";

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}
  log(e: { action: string; organizationId?: string; userId?: string; entityType?: string; entityId?: string; metadata?: object }) {
    return this.prisma.auditLog.create({ data: e });
  }
}
