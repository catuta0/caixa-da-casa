# Caixa da Casa

Livro de caixa para casas comunitárias e associações. Toda a gente vê as contas da casa e regista o que compra; o tesoureiro gere as rendas, as contas e o fundo de maneio.

- **Plafond de compras**: quanto já se gastou em comida e coisas para a casa, quanto falta e quanto dá por dia até ao fim do mês.
- **Plafond por semana**: o plafond do mês repartido por semanas (de sexta a quinta), com quanto falta esta semana e como correu cada semana.
- **Rendas**: a renda do mês é dividida por moradores, comensais e meios comensais. Cada pessoa vê logo quanto tem de pagar, quanto já pagou e o que vem de meses anteriores.
- **Calculadora da renda**: prevês cada despesa (renda ao senhorio, água, luz, gás, internet, comida…) e a app soma e divide. Podes escolher que despesas os comensais pagam, dar valores fixos e acertar à mão a parte de alguém.
- **Simulação da renda**: experimenta valores sem gravar nada. Com «ajustar automaticamente», mudar o valor de uma pessoa faz os outros acompanharem sem mudar o total; sem isso, vês a diferença para os gastos previstos. Junta receitas mensais ou anuais (quotas, alugueres, subsídios) que abatem na renda. O tesoureiro pode aplicar o resultado ao mês.
- **Compras pagas do próprio bolso**: são descontadas logo na renda de quem pagou (ou pagas em dinheiro pelo tesoureiro, se a pessoa precisar).
- **Fotos dos talões** em cada compra ou conta.
- **Fundo de maneio**: livro de caixa com entradas, saídas e saldo, mês a mês.
- **Histórico** de todos os meses e exportação para Excel (CSV).
- **Sem contas para o dia a dia**: quem tem o link vê tudo e regista compras. Só os **tesoureiros** entram (com a conta Google), e um tesoureiro novo tem de ser aprovado por outro.
- Funciona bem no telemóvel.

## Instalação rápida

Com o Docker instalado, o domínio a apontar para o servidor e o ID do Google criado (passos 1 a 3), basta um comando no servidor:

```bash
curl -fsSL https://raw.githubusercontent.com/catuta0/caixa-da-casa/main/instalar.sh | sh
```

O script faz 4 perguntas (domínio, ID do Google, o teu email de tesoureiro e o nome da casa), descarrega a imagem já pronta e arranca a app com HTTPS.

A imagem está em `ghcr.io/catuta0/caixa-da-casa` e funciona em servidores Intel/AMD e ARM (Raspberry Pi 4/5, servidores Ampere).

## Índice

1. [Quem pode fazer o quê](#quem-pode-fazer-o-quê)
2. [O que precisas](#o-que-precisas)
3. [Passo 1: preparar o servidor](#passo-1-preparar-o-servidor)
4. [Passo 2: apontar o domínio para o servidor](#passo-2-apontar-o-domínio-para-o-servidor)
5. [Passo 3: criar o ID de cliente do Google](#passo-3-criar-o-id-de-cliente-do-google)
6. [Passo 4: instalar e arrancar](#passo-4-instalar-e-arrancar)
7. [Passo 5: primeiros passos dentro da app](#passo-5-primeiros-passos-dentro-da-app)
8. [Como funcionam as contas](#como-funcionam-as-contas)
9. [Cópias de segurança](#cópias-de-segurança)
10. [Atualizar](#atualizar)
11. [Problemas comuns](#problemas-comuns)
12. [A imagem Docker](#a-imagem-docker)
13. [Testar no teu computador](#testar-no-teu-computador)
14. [Variáveis de configuração](#variáveis-de-configuração)
15. [Como está feito](#como-está-feito)

## Quem pode fazer o quê

| Quem | O que pode fazer |
|---|---|
| **Qualquer pessoa com o link** (sem conta) | Vê tudo: plafond, rendas, contas, fundo e histórico. Regista compras, com foto do talão. Pode anular ou juntar talões às compras que registou **no mesmo telemóvel/computador**. |
| **Tesoureiro** (entra com Google) | Tudo o resto: regista contas, pagamentos de renda e movimentos do fundo; gere as pessoas da casa (moradores, comensais, meios comensais); mexe nas definições e na calculadora da renda; anula qualquer registo; aprova ou retira outros tesoureiros. |
| **Tesoureiro à espera** | Entrou com o Google mas ainda não foi aprovado. Vê e regista compras como toda a gente até outro tesoureiro o aprovar. |

**Como se aprovam os tesoureiros:** quem entra primeiro fica logo tesoureiro (ou quem estiver em `TESOUREIRO_EMAIL`). A partir daí, cada tesoureiro novo fica à espera até um tesoureiro aprovado o aceitar em **Definições → Tesoureiros**. Se um dia deixar de haver tesoureiros aprovados, o próximo a entrar fica logo tesoureiro. Tem sempre de ficar pelo menos um.

**As pessoas da casa** não precisam de conta. O tesoureiro regista-as em **Definições → Pessoas da casa**:

| Tipo | Quanto paga |
|---|---|
| **Morador** | A sua parte de todas as despesas. |
| **Comensal** | Só a sua parte das despesas escolhidas na calculadora (por defeito: comida, internet e gás), ou um valor fixo. |
| **Meio comensal** | Metade do que paga um comensal. |

Em cada telemóvel, a pessoa escolhe uma vez **«Quem és tu?»** e passa a ver logo a sua renda; nas compras, «Quem comprou» já vem com o nome dela.

**Atenção:** como não há login para ver, **o link é a chave**. Quem o tiver vê os nomes e os valores da casa. Partilha-o só com a casa (o site está marcado para não aparecer no Google). Estas regras são verificadas no servidor, não só no ecrã.

## O que precisas

- **Um servidor** ligado à internet, com Linux: um VPS (Hetzner, DigitalOcean, OVH, Contabo… a partir de ~4 €/mês chega), um mini PC ou um Raspberry Pi 4/5 em casa. Chega 1 GB de RAM.
- **Um domínio** (ou subdomínio), por exemplo `caixa.minhacasa.pt`.
- **As portas 80 e 443** abertas para esse servidor (no router, se for em casa; na firewall, se for um VPS).
- **Uma conta Google** para criar o login (a tua serve).

O login do Google só funciona em **HTTPS**. A instalação inclui o [Caddy](https://caddyserver.com/), que pede e renova o certificado HTTPS sozinho.

## Passo 1: preparar o servidor

Entra no servidor por SSH e instala o Docker (inclui o Docker Compose):

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # para usar o docker sem sudo; sai e volta a entrar a seguir
```

Confirma que ficou instalado:

```bash
docker --version
docker compose version
```

Se o servidor tiver firewall (por exemplo `ufw`), abre as portas:

```bash
sudo ufw allow 80
sudo ufw allow 443
```

## Passo 2: apontar o domínio para o servidor

No sítio onde compraste o domínio (ou onde geres o DNS, por exemplo a Cloudflare), cria um registo:

| Tipo | Nome | Valor |
|---|---|---|
| `A` | `caixa` (ou `@` para o domínio principal) | o IP público do servidor |

Se usares a Cloudflare, deixa a nuvem **cinzenta** (só DNS) pelo menos até o certificado ser criado.

Pode demorar alguns minutos a propagar. Para confirmar: `ping caixa.minhacasa.pt` tem de responder com o IP do servidor.

**Servidor em casa?** No router, reencaminha as portas 80 e 443 para o IP local do servidor. Se o teu IP público muda, usa um serviço de DNS dinâmico (DuckDNS, No-IP, ou o do teu router).

## Passo 3: criar o ID de cliente do Google

É o que permite às pessoas entrarem com a conta Google. Só se faz uma vez e é gratuito.

1. Vai a <https://console.cloud.google.com/> e entra com a tua conta Google.
2. No topo, abre a lista de projetos e carrega em **Novo projeto**. Nome: `Caixa da Casa`. Cria e seleciona-o.
3. No menu, abre **Google Auth Platform** (em consolas mais antigas: **APIs e serviços → Ecrã de consentimento OAuth**) e carrega em **Começar**:
   - **Nome da app**: `Caixa da Casa`
   - **Email de apoio**: o teu
   - **Público**: **Externo**
   - **Contacto**: o teu email
4. Em **Público** (*Audience*), carrega em **Publicar app** para ficar **Em produção**. Assim qualquer conta Google consegue entrar (quem entra fica à espera da tua aprovação). Como a app só pede nome, email e foto, o Google não exige verificação.
5. Em **Clientes** (em consolas mais antigas: **Credenciais → Criar credenciais → ID de cliente OAuth**), carrega em **Criar cliente**:
   - **Tipo de aplicação**: **Aplicação Web**
   - **Nome**: `Caixa da Casa`
   - **Origens JavaScript autorizadas**: `https://caixa.minhacasa.pt` (o teu domínio, com `https://` e sem `/` no fim). Para testar no teu computador, junta também `http://localhost:3000`.
   - **URIs de redirecionamento autorizados**: deixa vazio, não é preciso.
6. Carrega em **Criar** e copia o **ID de cliente**. É parecido com `123456789-abc123.apps.googleusercontent.com`. O "segredo do cliente" não é preciso.

## Passo 4: instalar e arrancar

### Opção A: com o script (recomendado)

No servidor:

```bash
curl -fsSL https://raw.githubusercontent.com/catuta0/caixa-da-casa/main/instalar.sh | sh
```

O script:

1. confirma que o Docker está instalado;
2. cria a pasta `caixa-da-casa` e descarrega o `docker-compose.yml` e o `Caddyfile`;
3. pergunta o domínio, o ID de cliente do Google, o teu email (para ficares logo tesoureiro) e o nome da casa, e guarda tudo no `.env`;
4. descarrega a imagem e arranca a app e o Caddy (HTTPS).

Preferes ver o script antes de o correr? Descarrega-o, lê-o e só depois corre-o:

```bash
curl -fsSL https://raw.githubusercontent.com/catuta0/caixa-da-casa/main/instalar.sh -o instalar.sh
less instalar.sh
sh instalar.sh
```

### Opção B: à mão

```bash
mkdir caixa-da-casa && cd caixa-da-casa
curl -fsSLO https://raw.githubusercontent.com/catuta0/caixa-da-casa/main/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/catuta0/caixa-da-casa/main/Caddyfile
curl -fsSL https://raw.githubusercontent.com/catuta0/caixa-da-casa/main/.env.example -o .env
nano .env
```

Preenche o `.env`:

```bash
DOMINIO=caixa.minhacasa.pt
GOOGLE_CLIENT_ID=123456789-abc123.apps.googleusercontent.com
TESOUREIRO_EMAIL=o-teu-email@gmail.com
NOME_CASA=Casa comunitária
```

- `DOMINIO`: o domínio do passo 2, sem `https://`.
- `GOOGLE_CLIENT_ID`: o ID do passo 3.
- `TESOUREIRO_EMAIL` (opcional): o email da conta Google de quem vai ser tesoureiro desde o início, sem precisar de aprovação. Vários? Separa por vírgulas. Se ficar vazio, quem entrar primeiro fica tesoureiro.

Grava com `Ctrl+O`, `Enter`, e sai com `Ctrl+X`. Depois arranca:

```bash
docker compose up -d
```

### Confirmar que está a funcionar

```bash
docker compose ps          # os dois serviços devem estar "running" (a app fica "healthy")
docker compose logs -f     # Ctrl+C para sair
```

Abre `https://caixa.minhacasa.pt`, carrega em **Entrar como tesoureiro** e entra com a tua conta Google. Ficas **tesoureiro**. A app arranca sozinha se o servidor reiniciar.

**Já tens outro proxy** (Nginx, Traefik, Nginx Proxy Manager…) a ocupar as portas 80/443? Abre o `docker-compose.yml`, apaga o serviço `caddy` (e os volumes `caddy-dados` e `caddy-config`), descomenta as duas linhas `ports` do serviço `caixa` e aponta o teu proxy para `http://127.0.0.1:3000`. O proxy tem de fazer HTTPS e não pode guardar em buffer o endereço `/api/eventos` (atualizações em tempo real).

## Passo 5: primeiros passos dentro da app

Como tesoureiro:

1. **Definições → A casa e o dinheiro**: nome da casa, plafond mensal de compras e o dinheiro que há agora no fundo de maneio (saldo inicial).
2. **Definições → Pessoas da casa**: adiciona cada pessoa com o tipo (morador, comensal ou meio comensal) e o mês em que entrou. Se um comensal paga um valor fixo, põe-no aqui. Se tu vives na casa, adiciona-te também.
3. **Rendas → Calcular a renda do mês**: põe a previsão de cada despesa, marca o que os comensais pagam e carrega em **Usar como renda do mês**.
4. **Manda o link da app** às pessoas da casa. Cada uma escolhe **«Quem és tu?»** e já vê a sua renda. Para registar compras é só carregar em **+ Registar compra**.
5. **Outros tesoureiros?** Pede-lhes para abrirem a app e carregarem em **Entrar como tesoureiro**. Depois aprova-os em **Definições → Tesoureiros**.

**Alguém saiu da casa?** Em **Pessoas da casa**, edita a pessoa e põe o mês em **«Saiu no fim de»**. Não a apagues nem mudes o tipo, para as contas dos meses passados não mudarem.

### Trazer dados de outra Caixa da Casa

Se já tens os dados noutro sítio (por exemplo na versão que funcionava dentro do Claude), num ficheiro `.json` de exportação: entra como tesoureiro, vai a **Definições → Tesoureiros** e carrega em **Importar dados (.json)**. Traz as pessoas da casa, todos os registos, as fotos e as definições (plafond, fundo, rendas, calculadora). Só funciona com a app ainda vazia, para não duplicar nada.

## Como funcionam as contas

- **Plafond**: soma das compras do mês comparada com o plafond. A linha fina na barra mostra onde devíamos ir no dia de hoje.
- **Plafond da semana**: cada dia vale o plafond do mês a dividir pelos dias do mês; uma semana (de sexta a quinta) soma os seus 7 dias, mesmo que apanhe dois meses. Conta as compras com data nessa semana.
- **Renda de cada pessoa** = parte do mês + o que ficou por pagar antes − o que pagou a mais antes − compras pagas do seu bolso nesse mês. Pode ficar negativa: nesse caso a casa deve à pessoa e a diferença passa para o mês seguinte.
- **Divisão**: as despesas marcadas para comensais dividem-se por moradores, comensais (peso 1) e meios comensais (peso ½); o resto só pelos moradores. Os valores fixos saem primeiro. Os cêntimos que sobram vão para as primeiras pessoas por ordem alfabética.
- **Arredondar para cima** (opção na calculadora e no cartão da renda): cada pessoa paga um valor em euros certos, igual para todos do mesmo tipo; o que sobra fica no fundo de maneio. Vale para o mês em que a ligas; os meses já definidos não mudam.
- **Acerto à mão**: o tesoureiro pode mudar a parte de uma pessoa num mês; os outros não mudam e a renda total desse mês acompanha.
- **Meses passados não mudam**: quando a renda de um mês é definida, a regra desse mês (quem é comensal, valores fixos, despesas escolhidas) fica guardada. Mudanças de tipo contam a partir do mês que estás a ver.
- **Fundo de maneio**: saldo inicial + rendas recebidas + entradas − compras e contas pagas com o fundo − compras do bolso pagas em dinheiro − saídas.
- **Nada se apaga**: registos errados são **anulados** e ficam visíveis, riscados, com o nome de quem anulou.

## Cópias de segurança

Todos os dados ficam no volume Docker `caixa-dados`: a base de dados (`caixa.db`) e as fotos dos talões (`fotos/`).

**Rápido:** em **Definições → Tesoureiros**, os tesoureiros têm o botão **Descarregar cópia de segurança** (base de dados, sem as fotos).

**Completo** (base de dados + fotos), dentro da pasta da app:

```bash
docker run --rm --volumes-from caixa-da-casa -v "$PWD":/copia alpine \
  tar czf /copia/caixa-copia-$(date +%F).tgz -C /app/dados .
```

Guarda o `.tgz` noutro sítio (outro disco, uma drive). Uma vez por mês chega. Para automatizar, põe o comando no `crontab -e`, por exemplo todos os dias 1 às 4h:

```bash
0 4 1 * * cd /caminho/para/caixa-da-casa && docker run --rm --volumes-from caixa-da-casa -v "$PWD":/copia alpine tar czf /copia/caixa-copia-$(date +\%F).tgz -C /app/dados .
```

**Repor uma cópia:**

```bash
docker compose stop caixa
docker run --rm --volumes-from caixa-da-casa -v "$PWD":/copia alpine \
  sh -c "rm -rf /app/dados/* && tar xzf /copia/NOME-DA-COPIA.tgz -C /app/dados"
docker compose start caixa
```

## Atualizar

Na pasta da app:

```bash
docker compose pull
docker compose up -d
```

Os dados ficam no volume e não se perdem. Faz uma cópia de segurança antes, por precaução. (Correr outra vez o `instalar.sh` também atualiza, e mantém o `.env`.)

## Problemas comuns

**O botão "Continuar com o Google" não aparece, ou dá "origin_mismatch" / "The given origin is not allowed".**
O endereço que estás a usar não está nas **Origens JavaScript autorizadas** do passo 3. Tem de ser exatamente igual, com `https://`, sem `/` no fim e sem `www` se não o usas. As alterações no Google podem demorar alguns minutos.

**Aparece "O servidor ainda não tem o login do Google configurado".**
Falta o `GOOGLE_CLIENT_ID` no `.env`. Corrige e corre `docker compose up -d`.

**O site não abre, ou o navegador diz que o certificado não é válido.**
O Caddy não conseguiu criar o certificado. Confirma que o domínio aponta para o IP do servidor (passo 2) e que as portas 80 e 443 estão abertas. Vê o erro com `docker compose logs caddy`.

**Entro com o Google mas volto sempre ao ecrã de entrada.**
Estás a abrir a app sem HTTPS (os cookies de sessão só funcionam por HTTPS). Usa `https://`.

**Entrei como tesoureiro, mas diz que estou à espera de aprovação.**
Outro tesoureiro tem de te aprovar em **Definições → Tesoureiros**. Se és tu quem instalou e ainda não há outro tesoureiro, alguém entrou antes de ti: põe o teu email em `TESOUREIRO_EMAIL` no `.env`, corre `docker compose up -d` e entra outra vez.

**Perdemos o acesso de todos os tesoureiros.**
Põe o email de quem vai ser tesoureiro em `TESOUREIRO_EMAIL` no `.env` e corre `docker compose up -d`; ao entrar, essa conta é aprovada logo (se não tiver sido retirada antes).

**Uma pessoa não consegue anular uma compra que registou.**
Só dá no mesmo telemóvel/computador onde a registou (e se não apagou os dados do navegador). Um tesoureiro consegue sempre anular.

**As alterações dos outros só aparecem quando recarrego.**
Se usas o teu próprio proxy, desliga o buffering para `/api/eventos` (no Nginx: `proxy_buffering off;`).

## A imagem Docker

- **Imagem:** `ghcr.io/catuta0/caixa-da-casa`
- **Etiquetas:** `latest` (última versão do `main`), versões (`1.0.0`, `1.0`) quando há tags `v1.0.0`, e o commit (`7a4c4ec`…).
- **Arquiteturas:** `linux/amd64` e `linux/arm64`.
- É construída e publicada automaticamente pelo GitHub Actions (`.github/workflows/imagem-docker.yml`) sempre que há alterações no `main`.
- Dados em `/app/dados` (monta um volume aí). Porta `3000`. Corre como utilizador sem privilégios (`node`).

Sem Docker Compose (tens de pôr o teu próprio HTTPS à frente):

```bash
docker run -d --name caixa-da-casa --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -v caixa-dados:/app/dados \
  -e GOOGLE_CLIENT_ID=123456789-abc123.apps.googleusercontent.com \
  -e TESOUREIRO_EMAIL=o-teu-email@gmail.com \
  ghcr.io/catuta0/caixa-da-casa:latest
```

Para construir a imagem tu próprio (por exemplo depois de mudares o código):

```bash
git clone https://github.com/catuta0/caixa-da-casa.git
cd caixa-da-casa
docker build -t ghcr.io/catuta0/caixa-da-casa:latest .
docker compose up -d
```

## Testar no teu computador

Precisas de [Node.js](https://nodejs.org/) 22.13 ou mais recente (sem Docker):

```bash
git clone https://github.com/catuta0/caixa-da-casa.git
cd caixa-da-casa
npm install
DEV_LOGIN=1 npm start
```

Abre <http://localhost:3000>. Com `DEV_LOGIN=1`, em **Entrar como tesoureiro** aparece um **login de teste** (só email e nome, sem Google) que só funciona a partir do próprio computador. O primeiro email com que entrares fica tesoureiro; entra depois com outro (noutra janela privada) para veres a aprovação. **Nunca ligues o `DEV_LOGIN` no servidor.**

Os dados de teste ficam na pasta `dados/`; apaga-a para recomeçar.

Para testares o login do Google em localhost, junta `http://localhost:3000` às origens autorizadas e arranca com `GOOGLE_CLIENT_ID=... COOKIE_SECURE=0 npm start`.

## Variáveis de configuração

| Variável | Para quê |
|---|---|
| `GOOGLE_CLIENT_ID` | ID de cliente OAuth do Google. Obrigatório para entrar com Google. |
| `TESOUREIRO_EMAIL` | Opcional. Email(s) Google aprovados logo como tesoureiros, separados por vírgulas. Se ficar vazio, quem entrar primeiro fica tesoureiro. (`ADMIN_EMAIL` também funciona, é o nome antigo.) |
| `DOMINIO` | Domínio usado pelo Caddy para o HTTPS. |
| `NOME_CASA` | Nome no ecrã de entrada até ser mudado em Definições. |
| `PORT` | Porta interna (por defeito `3000`). |
| `DATA_DIR` | Pasta dos dados (no Docker é `/app/dados`). |
| `COOKIE_SECURE` | `1` para cookies só por HTTPS (é o padrão em produção). `0` só para testes sem HTTPS. |
| `TRUST_PROXY` | Que proxies são de confiança (por defeito, redes locais e privadas). |
| `DEV_LOGIN` | `1` liga o login de teste, só para desenvolvimento no próprio computador. |

## Como está feito

```
caixa-da-casa/
├── server.js            servidor Node.js (Express) + SQLite embutido (node:sqlite)
├── public/index.html    a app (HTML, CSS e JavaScript, sem build)
├── Dockerfile           imagem da app
├── docker-compose.yml   app (imagem pronta) + Caddy (HTTPS)
├── Caddyfile            configuração do Caddy
├── instalar.sh          instalação com um comando
├── .env.example         modelo da configuração
└── .github/workflows/   constrói e publica a imagem Docker
```

- Sem login para ver e registar compras; cada aparelho tem um cookie anónimo para poder anular as suas compras. Pedidos de quem não tem conta têm um limite por hora.
- Tesoureiros entram com **Google Identity Services**; o token é verificado no servidor e a sessão fica num cookie `HttpOnly`.
- Dados em **SQLite** (um ficheiro), fotos em disco. Não há serviços externos além do login do Google e das fontes do Google Fonts.
- Atualizações em tempo real com **Server-Sent Events**.
- Fotos reduzidas no telemóvel antes de serem enviadas; o servidor só aceita JPG, PNG, WEBP, GIF e PDF (confirmados pelo conteúdo do ficheiro).
