# Caixa da Casa

Livro de caixa para casas comunitárias e associações. Toda a gente vê as contas da casa e regista o que compra; o tesoureiro gere as rendas, as contas e o fundo de maneio.

- **Plafond de compras**: quanto já se gastou em comida e coisas para a casa, quanto falta e quanto dá por dia até ao fim do mês.
- **Rendas**: a renda do mês é dividida por moradores, comensais e meios comensais. Cada pessoa vê logo quanto tem de pagar, quanto já pagou e o que vem de meses anteriores.
- **Calculadora da renda**: prevês cada despesa (renda ao senhorio, água, luz, gás, internet, comida…) e a app soma e divide. Podes escolher que despesas os comensais pagam, dar valores fixos e acertar à mão a parte de alguém.
- **Compras pagas do próprio bolso**: são descontadas logo na renda de quem pagou (ou pagas em dinheiro pelo tesoureiro, se a pessoa precisar).
- **Fotos dos talões** em cada compra ou conta.
- **Fundo de maneio**: livro de caixa com entradas, saídas e saldo, mês a mês.
- **Histórico** de todos os meses e exportação para Excel (CSV).
- **Login com conta Google**; o administrador aprova quem entra e escolhe os tesoureiros.
- Funciona bem no telemóvel.

## Índice

1. [Quem pode fazer o quê](#quem-pode-fazer-o-quê)
2. [O que precisas](#o-que-precisas)
3. [Passo 1: preparar o servidor](#passo-1-preparar-o-servidor)
4. [Passo 2: apontar o domínio para o servidor](#passo-2-apontar-o-domínio-para-o-servidor)
5. [Passo 3: criar o ID de cliente do Google](#passo-3-criar-o-id-de-cliente-do-google)
6. [Passo 4: descarregar e configurar a app](#passo-4-descarregar-e-configurar-a-app)
7. [Passo 5: arrancar](#passo-5-arrancar)
8. [Passo 6: primeiros passos dentro da app](#passo-6-primeiros-passos-dentro-da-app)
9. [Como funcionam as contas](#como-funcionam-as-contas)
10. [Cópias de segurança](#cópias-de-segurança)
11. [Atualizar](#atualizar)
12. [Problemas comuns](#problemas-comuns)
13. [Testar no teu computador](#testar-no-teu-computador)
14. [Variáveis de configuração](#variáveis-de-configuração)
15. [Como está feito](#como-está-feito)

## Quem pode fazer o quê

| Papel | O que pode fazer |
|---|---|
| **À espera** | Entrou com o Google mas ainda não foi aprovado. Não vê nada. |
| **Visitante** | Vê tudo e regista compras. Não entra na divisão da renda. |
| **Morador** | Vê tudo e regista compras. Paga a sua parte de todas as despesas. |
| **Comensal** | Como o morador, mas só paga a sua parte das despesas escolhidas (por defeito: comida, internet e gás), ou um valor fixo. |
| **Meio comensal** | Paga metade do que paga um comensal. |
| **Tesoureiro** | Além do seu tipo, regista contas, pagamentos de renda e movimentos do fundo, e mexe nas definições e na calculadora da renda. |
| **Administrador** | Tudo o que o tesoureiro faz, e ainda aprova pessoas, muda o tipo, dá ou tira a permissão de tesoureiro e bloqueia contas. |

Cada membro pode anular ou juntar talões às **suas** compras. Estas regras são verificadas no servidor, não só no ecrã.

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

## Passo 4: descarregar e configurar a app

No servidor:

```bash
git clone https://github.com/catuta0/caixa-da-casa.git
cd caixa-da-casa
cp .env.example .env
nano .env
```

Preenche o `.env`:

```bash
DOMINIO=caixa.minhacasa.pt
GOOGLE_CLIENT_ID=123456789-abc123.apps.googleusercontent.com
ADMIN_EMAIL=o-teu-email@gmail.com
NOME_CASA=Casa comunitária
```

- `DOMINIO`: o domínio do passo 2, sem `https://`.
- `GOOGLE_CLIENT_ID`: o ID do passo 3.
- `ADMIN_EMAIL`: o email da conta Google de quem vai administrar. Para ter mais do que um administrador, separa por vírgulas.

Grava com `Ctrl+O`, `Enter`, e sai com `Ctrl+X`.

**Já tens outro proxy** (Nginx, Traefik, Nginx Proxy Manager…) a ocupar as portas 80/443? Abre o `docker-compose.yml`, apaga o serviço `caddy` (e os volumes `caddy-dados` e `caddy-config`), descomenta as duas linhas `ports` do serviço `caixa` e aponta o teu proxy para `http://127.0.0.1:3000`. O proxy tem de fazer HTTPS e não pode guardar em buffer o endereço `/api/eventos` (atualizações em tempo real).

## Passo 5: arrancar

```bash
docker compose up -d --build
```

A primeira vez demora 1 a 3 minutos. Para ver se está tudo bem:

```bash
docker compose ps          # os dois serviços devem estar "running" / "healthy"
docker compose logs -f     # Ctrl+C para sair
```

Abre `https://caixa.minhacasa.pt` e entra com a conta Google do `ADMIN_EMAIL`. Ficas **administrador** e **tesoureiro**.

A app arranca sozinha se o servidor reiniciar.

## Passo 6: primeiros passos dentro da app

1. **Definições → A casa e o dinheiro**: nome da casa, plafond mensal de compras e o dinheiro que há agora no fundo de maneio (saldo inicial).
2. **Manda o endereço da app** às pessoas da casa. Cada uma entra com o Google e fica **à espera**.
3. **Definições → Membros**: aprova cada pessoa e escolhe o tipo (morador, comensal, meio comensal ou visitante) e o mês em que entrou. Se um comensal paga um valor fixo, põe-no aqui. Marca **Tesoureiro** em quem vai gerir o dinheiro.
4. Se tu próprio vives na casa, edita-te e muda o teu tipo para **Morador**, para entrares na divisão da renda.
5. **Rendas → Calcular a renda do mês**: põe a previsão de cada despesa, marca o que os comensais pagam e carrega em **Usar como renda do mês**.

A partir daí, cada pessoa só precisa de abrir a app e carregar em **+ Registar compra**.

**Alguém saiu da casa?** Edita a pessoa e põe o mês em **«Saiu no fim de»**. Não mudes o tipo dela, para as contas dos meses passados não mudarem. Para lhe tirar o acesso à app, marca **«Sem acesso»**.

## Como funcionam as contas

- **Plafond**: soma das compras do mês comparada com o plafond. A linha fina na barra mostra onde devíamos ir no dia de hoje.
- **Renda de cada pessoa** = parte do mês + o que ficou por pagar antes − o que pagou a mais antes − compras pagas do seu bolso nesse mês. Pode ficar negativa: nesse caso a casa deve à pessoa e a diferença passa para o mês seguinte.
- **Divisão**: as despesas marcadas para comensais dividem-se por moradores, comensais (peso 1) e meios comensais (peso ½); o resto só pelos moradores. Os valores fixos saem primeiro. Os cêntimos que sobram vão para as primeiras pessoas por ordem alfabética.
- **Acerto à mão**: o tesoureiro pode mudar a parte de uma pessoa num mês; os outros não mudam e a renda total desse mês acompanha.
- **Meses passados não mudam**: quando a renda de um mês é definida, a regra desse mês (quem é comensal, valores fixos, despesas escolhidas) fica guardada. Mudanças de tipo contam a partir do mês que estás a ver.
- **Fundo de maneio**: saldo inicial + rendas recebidas + entradas − compras e contas pagas com o fundo − compras do bolso pagas em dinheiro − saídas.
- **Nada se apaga**: registos errados são **anulados** e ficam visíveis, riscados, com o nome de quem anulou.

## Cópias de segurança

Todos os dados ficam no volume Docker `caixa-dados`: a base de dados (`caixa.db`) e as fotos dos talões (`fotos/`).

**Rápido:** em **Definições**, o administrador tem o botão **Descarregar cópia de segurança** (base de dados, sem as fotos).

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

```bash
cd caixa-da-casa
git pull
docker compose up -d --build
```

Os dados ficam no volume e não se perdem. Faz uma cópia de segurança antes, por precaução.

## Problemas comuns

**O botão "Continuar com o Google" não aparece, ou dá "origin_mismatch" / "The given origin is not allowed".**
O endereço que estás a usar não está nas **Origens JavaScript autorizadas** do passo 3. Tem de ser exatamente igual, com `https://`, sem `/` no fim e sem `www` se não o usas. As alterações no Google podem demorar alguns minutos.

**Aparece "O servidor ainda não tem o login do Google configurado".**
Falta o `GOOGLE_CLIENT_ID` no `.env`. Corrige e corre `docker compose up -d`.

**O site não abre, ou o navegador diz que o certificado não é válido.**
O Caddy não conseguiu criar o certificado. Confirma que o domínio aponta para o IP do servidor (passo 2) e que as portas 80 e 443 estão abertas. Vê o erro com `docker compose logs caddy`.

**Entro com o Google mas volto sempre ao ecrã de entrada.**
Estás a abrir a app sem HTTPS (os cookies de sessão só funcionam por HTTPS). Usa `https://`.

**Entrei, mas diz que estou à espera de aprovação e sou eu o administrador.**
O email no `ADMIN_EMAIL` não é o da conta com que entraste. Corrige o `.env`, corre `docker compose up -d` e entra outra vez.

**Uma pessoa diz que não consegue entrar.**
Vê em **Definições → Membros** se está à espera (aprova-a) ou marcada como **Sem acesso**.

**As alterações dos outros só aparecem quando recarrego.**
Se usas o teu próprio proxy, desliga o buffering para `/api/eventos` (no Nginx: `proxy_buffering off;`).

## Testar no teu computador

Precisas de [Node.js](https://nodejs.org/) 22.13 ou mais recente (sem Docker):

```bash
git clone https://github.com/catuta0/caixa-da-casa.git
cd caixa-da-casa
npm install
DEV_LOGIN=1 ADMIN_EMAIL=teste@exemplo.pt npm start
```

Abre <http://localhost:3000>. Com `DEV_LOGIN=1` aparece um **login de teste** (só email e nome, sem Google) que só funciona a partir do próprio computador. Entra primeiro com o email do `ADMIN_EMAIL`, e depois com outros emails para veres como fica para um membro. **Nunca ligues o `DEV_LOGIN` no servidor.**

Os dados de teste ficam na pasta `dados/`; apaga-a para recomeçar.

Para testares o login do Google em localhost, junta `http://localhost:3000` às origens autorizadas e arranca com `GOOGLE_CLIENT_ID=... COOKIE_SECURE=0 npm start`.

## Variáveis de configuração

| Variável | Para quê |
|---|---|
| `GOOGLE_CLIENT_ID` | ID de cliente OAuth do Google. Obrigatório para entrar com Google. |
| `ADMIN_EMAIL` | Email(s) Google do administrador, separados por vírgulas. Se ficar vazio, a primeira pessoa a entrar fica administradora. |
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
├── docker-compose.yml   app + Caddy (HTTPS)
├── Caddyfile            configuração do Caddy
└── .env.example         modelo da configuração
```

- Login com **Google Identity Services**; o token é verificado no servidor e a sessão fica num cookie `HttpOnly`.
- Dados em **SQLite** (um ficheiro), fotos em disco. Não há serviços externos além do login do Google e das fontes do Google Fonts.
- Atualizações em tempo real com **Server-Sent Events**.
- Fotos reduzidas no telemóvel antes de serem enviadas; o servidor só aceita JPG, PNG, WEBP, GIF e PDF (confirmados pelo conteúdo do ficheiro).
