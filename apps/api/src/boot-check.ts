// Verificação de inicialização: sobe o contêiner de injeção de dependências do Nest com o AppModule REAL (sem abrir porta).
// Pega o que os testes unitários não pegam, porque eles instanciam as classes à mão (ex.: um parâmetro de construtor que o
// Nest não consegue injetar). Roda no CI e pode ser rodado localmente: pnpm --filter @dabi/api boot-check
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
  await app.close();
  console.log("boot-check: a aplicação inicializou e todas as dependências foram resolvidas");
  process.exit(0);
})().catch((e) => {
  console.error("boot-check FALHOU:", String(e?.message ?? e).split("\n")[0]);
  process.exit(1);
});
