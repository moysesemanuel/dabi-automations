/**
 * Guias do assistente de conexão. Texto em português simples, baseado nas páginas oficiais da Meta
 * (lidas em 08/11/2026). `needsValidation` lista o que NÃO foi confirmado na fonte oficial e deve ser
 * conferido na interface real antes de divulgar para clientes. Nunca é exibido ao usuário.
 */
export type GuideId = "professional" | "portfolio-create" | "portfolio-find" | "instagram-in-portfolio" | "messages-access";

export interface Guide {
  id: GuideId;
  title: string;
  intro: string;
  steps: string[];
  tips: string[];
  links: { label: string; url: string }[];
  needsValidation?: string[];
}

export const GUIDES: Record<GuideId, Guide> = {
  professional: {
    id: "professional",
    title: "Como mudar para conta profissional",
    intro: "A conexão só funciona com conta profissional (Empresa ou Criador de conteúdo). É gratuito e dá para voltar à conta pessoal depois.",
    steps: [
      "No app do Instagram, toque na sua foto de perfil, no canto inferior direito.",
      "Toque em “Mais” e abra “Configurações e atividade”.",
      "Em “Para profissionais”, toque em “Tipo de conta e ferramentas”.",
      "Escolha “Mudar para conta profissional”.",
      "Escolha a categoria que melhor descreve o que você faz.",
      "Escolha “Empresa” (ou “Criador de conteúdo”) e toque em “Avançar”.",
    ],
    tips: ["Se a sua conta for privada, ela passa a ser pública ao virar profissional.", "Também dá para fazer isso pelo site instagram.com, em Configurações."],
    links: [{ label: "Ajuda oficial do Instagram", url: "https://help.instagram.com/502981923235522/?locale=pt_BR" }],
  },
  "portfolio-create": {
    id: "portfolio-create",
    title: "Como criar um portfólio empresarial da Meta",
    intro: "O portfólio empresarial é o “cadastro da sua empresa” na Meta. Ele reúne Página, Instagram e anúncios em um só lugar. É gratuito.",
    steps: [
      "No computador, acesse business.facebook.com e entre com o seu perfil do Facebook.",
      "Clique no menu suspenso abaixo de “Página inicial”, no canto superior esquerdo.",
      "Clique em “Criar um portfólio empresarial”.",
      "Digite o nome da sua empresa (o nome público, sem caracteres especiais).",
      "Informe seu nome, sobrenome e e-mail comercial.",
      "Clique em “Criar” e confirme o e-mail que a Meta enviar.",
    ],
    tips: ["Você precisa de um perfil do Facebook para criar o portfólio.", "É possível criar até dois portfólios.", "Quem cria o portfólio tem controle total dele."],
    links: [{ label: "Ajuda oficial da Meta", url: "https://www.facebook.com/business/help/1710077379203657?locale=pt_BR" }],
  },
  "portfolio-find": {
    id: "portfolio-find",
    title: "Como saber se você já tem um portfólio",
    intro: "Se alguém já montou os anúncios ou a Página da sua empresa, talvez o portfólio já exista.",
    steps: [
      "No computador, acesse business.facebook.com e entre com o seu perfil do Facebook.",
      "Abra “Configurações” no Meta Business Suite.",
      "No menu da esquerda, escolha “Informações do portfólio empresarial”.",
      "Se aparecer o nome da sua empresa com um número de identificação, esse é o seu portfólio.",
      "Se não houver nenhum portfólio, siga o guia para criar um.",
    ],
    tips: ["Se você não tem acesso total ao portfólio, peça a quem administra para conceder.", "Cada conta do Instagram só pode estar em um portfólio."],
    links: [
      { label: "Onde ver as informações do portfólio (Meta)", url: "https://www.facebook.com/business/help/1181250022022158?locale=pt_BR" },
      { label: "Como criar um portfólio (Meta)", url: "https://www.facebook.com/business/help/1710077379203657?locale=pt_BR" },
    ],
    needsValidation: ["O artigo oficial confirma onde ver as informações de um portfólio existente, mas não descreve o que a tela mostra para quem não tem nenhum; o último passo é uma dedução. Conferir na interface real."],
  },
  "instagram-in-portfolio": {
    id: "instagram-in-portfolio",
    title: "Como colocar o Instagram no portfólio",
    intro: "Para o DaBiChat acessar o seu Instagram, a conta precisa fazer parte do seu portfólio empresarial.",
    steps: [
      "Confirme que a sua conta é profissional e que você tem controle total do portfólio.",
      "No computador, abra o Meta Business Suite e entre em “Configurações” do seu portfólio.",
      "No menu da esquerda, em “Contas”, clique em “Contas do Instagram”.",
      "Clique em “Adicionar” e depois em “Adicionar conta do Instagram”.",
      "Na janela que abrir, entre com o usuário e a senha do Instagram (e o código de segurança, se pedir).",
      "Clique em “Confirmar”. A Meta avisa quando a conta for adicionada.",
    ],
    tips: [
      "Cada conta do Instagram só pode estar em um portfólio. Se ela já estiver em outro, é preciso removê-la de lá ou receber acesso.",
      "Às vezes outro administrador precisa aprovar, em “Solicitações” nas configurações.",
      "Conta pessoal não pode ser adicionada: mude antes para conta profissional.",
    ],
    links: [
      { label: "Como adicionar (Meta)", url: "https://www.facebook.com/business/help/620548115562686?locale=pt_BR" },
      { label: "Se não conseguir adicionar (Meta)", url: "https://www.facebook.com/business/help/567938347644871?locale=pt_BR" },
    ],
  },
  "messages-access": {
    id: "messages-access",
    title: "Como permitir o acesso às mensagens no Instagram",
    intro: "Para o DaBiChat enviar respostas por mensagem, o Instagram precisa permitir que ferramentas conectadas acessem as mensagens.",
    steps: [
      "No app do Instagram, abra o seu perfil e toque em “Menu”, no canto superior direito.",
      "Escolha “Mensagens e respostas ao story”.",
      "Toque em “Pedidos de contato”.",
      "Em “Ferramentas conectadas”, ative “Permitir acesso às mensagens”.",
    ],
    tips: ["Você pode mudar isso a qualquer momento.", "Se estiver desativado, as mensagens só podem ser vistas e enviadas pelo próprio Instagram."],
    links: [{ label: "Ajuda oficial do Instagram", url: "https://help.instagram.com/791161338412168/?locale=pt_BR" }],
    needsValidation: ["O nome exato dos menus pode variar conforme a versão do app e o aparelho (a própria Central de Ajuda cita “Controles de mensagens” no iPad). Conferir no aparelho da conta de teste."],
  },
};

/** URLs oficiais devem ser sempre das centrais de ajuda da Meta/Instagram (verificado em teste). */
export const OFFICIAL_HOSTS = ["www.facebook.com", "help.instagram.com"];
