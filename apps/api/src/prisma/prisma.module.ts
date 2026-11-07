import { Global, Injectable, Module, OnModuleDestroy } from "@nestjs/common";
import { PrismaClient } from "@dabi/database";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy() { await this.$disconnect(); }
}

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
