export * from "@prisma/client";
import { PrismaClient } from "@prisma/client";
export const createPrisma = () => new PrismaClient();
