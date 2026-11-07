import { Injectable } from "@nestjs/common";
import { loadEnv } from "@dabi/config";
import { PrismaService } from "../prisma/prisma.module";
import { connectInstagramAccount, type ConnectInput } from "./instagram-connect";

/** Será reutilizado pelo callback do OAuth. */
@Injectable()
export class InstagramAccountsService {
  constructor(private prisma: PrismaService) {}
  connect(input: ConnectInput) {
    const env = loadEnv();
    return connectInstagramAccount(
      { prisma: this.prisma, tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY, graphVersion: env.META_GRAPH_VERSION },
      input,
    );
  }
}
