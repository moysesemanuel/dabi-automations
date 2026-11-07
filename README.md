# DaBi Automations

**Plataforma de automação de interações e mensagens para redes sociais.**

O **DaBi Automations** é um projeto da [DaBi Tech](https://dabitech.com.br) que tem como objetivo simplificar a criação e o gerenciamento de automações para Instagram, permitindo que criadores de conteúdo, afiliados e empresas automatizem interações com seu público.

O projeto começa com uma funcionalidade específica: **enviar respostas privadas automaticamente a partir de comentários em publicações do Instagram**, utilizando a API oficial da Meta.

A arquitetura será preparada para evoluir de uma ferramenta de uso interno para uma plataforma SaaS multi-tenant, com suporte a múltiplos clientes, contas e fluxos de automação.

> **Status:** Em planejamento e desenvolvimento inicial. As funcionalidades e decisões arquiteturais descritas neste documento representam o escopo previsto e poderão evoluir durante a implementação.

---

## Objetivo

Criar uma plataforma simples, segura e escalável para automatizar interações em redes sociais.

O desenvolvimento seguirá três princípios:

- **Simplicidade:** facilitar a configuração de automações sem exigir conhecimento técnico.
- **Segurança:** proteger credenciais, mensagens e dados dos usuários desde a arquitetura inicial.
- **Evolução:** construir uma base modular que permita adicionar funcionalidades sem comprometer a manutenção do sistema.

## Funcionalidades previstas

### MVP — Automações de comentários no Instagram

- [ ] Autenticação de usuários.
- [ ] Estrutura de organizações e permissões.
- [ ] Conexão com contas profissionais do Instagram via OAuth.
- [ ] Listagem de publicações e Reels.
- [ ] Criação de automações por palavras-chave.
- [ ] Associação de automações a publicações específicas.
- [ ] Recebimento de comentários por webhooks.
- [ ] Envio automático de respostas privadas conforme as permissões e regras da Meta.
- [ ] Configuração de mensagens e links personalizados.
- [ ] Ativação, pausa e desativação de automações.
- [ ] Histórico de eventos e envios.
- [ ] Monitoramento de falhas.
- [ ] Proteção contra processamento duplicado de eventos.
- [ ] Dashboard com métricas básicas.

### Evoluções futuras

- [ ] Editor visual de fluxos.
- [ ] Automações de mensagens diretas.
- [ ] Respostas a interações em Stories.
- [ ] Múltiplas contas por organização.
- [ ] Tags e segmentação de contatos.
- [ ] Caixa de entrada compartilhada.
- [ ] Integrações com serviços externos.
- [ ] Automações com inteligência artificial.
- [ ] Integração com WhatsApp Business Platform.
- [ ] API pública e webhooks para desenvolvedores.
- [ ] Planos de assinatura e cobrança.
- [ ] Relatórios e análises avançadas.

As funcionalidades dependerão das permissões e limitações das APIs oficiais de cada plataforma.

---

## Stack tecnológica

| Camada | Tecnologia |
|---|---|
| Linguagem | TypeScript |
| Frontend | Next.js, React, Tailwind CSS |
| Backend | Node.js, NestJS |
| ORM | Prisma |
| Banco de dados | PostgreSQL |
| Filas e jobs | BullMQ |
| Cache e broker | Redis |
| Infraestrutura local | Docker, Docker Compose |
| Integração Instagram | Meta Instagram Platform |
| Testes | Jest, Playwright |
| CI/CD | GitHub Actions |

A stack poderá ser ajustada conforme as necessidades identificadas no desenvolvimento.

## Arquitetura

O projeto seguirá inicialmente uma arquitetura de **monólito modular com processamento assíncrono**, organizada em monorepo.

```text
dabi-automations/
├── apps/
│   ├── web/
│   │   └── # Dashboard Next.js
│   ├── api/
│   │   └── # API NestJS
│   └── worker/
│       └── # Processamento assíncrono
│
├── packages/
│   ├── database/
│   │   └── # Prisma e PostgreSQL
│   ├── contracts/
│   │   └── # Contratos e validações
│   └── config/
│       └── # Configurações compartilhadas
│
├── infra/
│   └── docker/
│       └── # Infraestrutura local
│
├── docs/
│   ├── architecture/
│   ├── security/
│   └── meta-integration/
│
└── README.md
```

### Componentes principais

**Frontend:** interface para gerenciar contas conectadas, publicações, automações e histórico.

**API:** autenticação, autorização, regras de negócio, integração com a Meta e recebimento de webhooks.

**Worker:** processamento assíncrono de eventos, execução de automações e gerenciamento de falhas.

**PostgreSQL:** persistência de usuários, organizações, configurações, eventos e registros de execução.

**Redis e BullMQ:** processamento de filas, controle de concorrência e retentativas.

## Fluxo de automação

O fluxo inicial previsto é:

1. O usuário conecta uma conta profissional do Instagram.
2. Seleciona uma publicação ou Reel.
3. Configura uma palavra-chave, por exemplo `LINK`.
4. Define a mensagem privada e o link de destino.
5. Ativa a automação.
6. Um seguidor comenta a palavra-chave na publicação.
7. A Meta envia o evento para o webhook da aplicação.
8. A API valida e registra o evento.
9. O worker identifica a automação correspondente.
10. A plataforma solicita o envio da resposta privada pela API oficial da Meta.
11. O resultado é registrado no histórico.

O processamento deverá respeitar os limites, permissões e políticas da Meta, incluindo as restrições de respostas privadas.

---

## Modelo de dados

A arquitetura será preparada para múltiplas organizações, mesmo que o MVP seja utilizado inicialmente por uma única conta.

Principais entidades previstas:

| Entidade | Responsabilidade |
|---|---|
| `User` | Identidade dos usuários |
| `Organization` | Organização ou cliente |
| `Membership` | Associação de usuários a organizações |
| `SocialAccount` | Contas de redes sociais conectadas |
| `SocialCredential` | Credenciais e tokens protegidos |
| `Media` | Publicações monitoradas |
| `Automation` | Regras e configurações de automações |
| `AutomationEvent` | Eventos recebidos |
| `MessageDelivery` | Histórico e status de mensagens |
| `AuditLog` | Auditoria de operações sensíveis |

O isolamento dos dados entre organizações será uma responsabilidade explícita da camada de aplicação e persistência.

---

## Segurança

A segurança será considerada em todas as etapas do desenvolvimento.

### Controles previstos

- Autenticação e autorização por funções.
- Isolamento de dados entre organizações.
- Criptografia de tokens e credenciais sensíveis.
- Comunicação HTTPS em produção.
- Validação da autenticidade dos webhooks.
- Proteção contra eventos duplicados.
- Validação de entradas e dados externos.
- Proteção contra exposição de segredos em logs.
- Gerenciamento seguro de variáveis de ambiente.
- Monitoramento de falhas e eventos relevantes.
- Auditoria de operações administrativas.
- Políticas de retenção e exclusão de dados.

### Testes de segurança

O projeto pretende utilizar práticas e referências da OWASP, incluindo:

- OWASP Application Security Verification Standard (ASVS).
- OWASP Web Security Testing Guide (WSTG).
- Análise estática de código.
- Verificação de dependências vulneráveis.
- Testes automatizados de autenticação e autorização.
- Testes de isolamento entre organizações.
- Testes de segurança em ambiente controlado.

Ferramentas previstas:

- OWASP ZAP.
- Semgrep.
- Gitleaks.
- GitHub Actions.

Auditorias independentes e testes profissionais de intrusão poderão ser realizados conforme a maturidade e a exposição comercial do produto.

**O projeto não declara possuir certificações ISO 27001, SOC 2, CSA STAR ou ISO 42001.**

---

## Integração com a Meta

A integração com o Instagram será desenvolvida exclusivamente por meio das APIs oficiais disponibilizadas pela Meta.

Documentação:

[Meta Instagram Platform](https://developers.facebook.com/docs/instagram-platform/)

A aplicação deverá utilizar os mecanismos de autenticação, autorização e permissões exigidos pela plataforma.

O acesso a contas externas poderá depender de revisão do aplicativo e aprovação de permissões pela Meta.

Não estão previstas integrações baseadas em captura de senhas, scraping ou automação não autorizada da interface do Instagram.

---

## Roadmap

### Fase 1 — Fundação

- [ ] Configurar monorepo.
- [ ] Configurar frontend Next.js.
- [ ] Configurar backend NestJS.
- [ ] Configurar Prisma e PostgreSQL.
- [ ] Configurar Redis e BullMQ.
- [ ] Implementar autenticação.
- [ ] Criar estrutura multi-tenant.

### Fase 2 — Instagram

- [ ] Configurar aplicação no Meta for Developers.
- [ ] Implementar autenticação OAuth.
- [ ] Implementar gerenciamento de tokens.
- [ ] Configurar webhooks.
- [ ] Implementar consulta de publicações.
- [ ] Validar o envio de respostas privadas.

### Fase 3 — Motor de automações

- [ ] Implementar gatilhos por comentários.
- [ ] Implementar filtros por palavras-chave.
- [ ] Integrar processamento em filas.
- [ ] Implementar idempotência.
- [ ] Registrar execuções e falhas.
- [ ] Implementar controles de ativação e pausa.

### Fase 4 — Dashboard

- [ ] Desenvolver painel inicial.
- [ ] Criar gerenciamento de contas.
- [ ] Criar interface de automações.
- [ ] Desenvolver histórico de execuções.
- [ ] Implementar indicadores básicos.

### Fase 5 — Qualidade e validação

- [ ] Implementar testes unitários.
- [ ] Implementar testes de integração.
- [ ] Implementar testes E2E.
- [ ] Configurar verificações de segurança no CI.
- [ ] Executar testes de segurança em homologação.
- [ ] Validar o funcionamento em uma conta real autorizada.

---

## Diretrizes de desenvolvimento

O projeto seguirá as seguintes práticas:

- TypeScript com tipagem estrita.
- Separação entre regras de negócio e infraestrutura.
- Validação explícita de entradas.
- Código modular e reutilizável.
- Testes para funcionalidades críticas.
- Versionamento semântico quando aplicável.
- Documentação de decisões arquiteturais.
- Revisão de código e análise de dependências.
- Nenhum segredo ou token real versionado no repositório.

O foco inicial será manter o sistema simples e sustentável, evitando complexidade desnecessária.

## Público-alvo

A primeira versão será utilizada internamente para validar automações relacionadas à produção de conteúdo e à divulgação de produtos.

Em uma possível expansão comercial, o produto poderá atender:

- Criadores de conteúdo.
- Afiliados de marketplaces.
- Pequenos negócios.
- Lojas virtuais.
- Profissionais de marketing digital.
- Agências que gerenciam contas de clientes.

A estratégia comercial dependerá da validação do produto e das condições de uso das plataformas integradas.

## Status do projeto

**Em desenvolvimento inicial.**

O repositório documenta a arquitetura e o planejamento do produto. Ainda não há uma versão pública estável.

As instruções de instalação, execução e contribuição serão adicionadas quando a estrutura executável do projeto estiver disponível.

## Licença

**Proprietário — Todos os direitos reservados.**

O código-fonte pertence à DaBi Tech. Sua disponibilização neste repositório não concede automaticamente permissão para copiar, modificar, distribuir ou explorar comercialmente o software.

Uma licença específica poderá ser definida futuramente.

## Desenvolvido por

**DaBi Tech — Digital Solutions**

Soluções digitais, automação e desenvolvimento de software.

Website: https://dabitech.com.br

---

Copyright © 2026 DaBi Tech. Todos os direitos reservados.

*DaBi Automations é um projeto independente, não afiliado, patrocinado ou endossado pela Meta.*
