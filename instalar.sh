#!/bin/sh
# Instala (ou atualiza) a Caixa da Casa com Docker.
# Uso: curl -fsSL https://raw.githubusercontent.com/catuta0/caixa-da-casa/main/instalar.sh | sh
set -e

REPO="https://raw.githubusercontent.com/catuta0/caixa-da-casa/main"
PASTA="${PASTA:-caixa-da-casa}"

if ! command -v docker >/dev/null 2>&1; then
  echo "O Docker não está instalado. Instala-o com:"
  echo "  curl -fsSL https://get.docker.com | sh"
  echo "e volta a correr este script."
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Falta o Docker Compose (plugin 'docker compose'). Instala o Docker com:"
  echo "  curl -fsSL https://get.docker.com | sh"
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Não consigo falar com o Docker. Corre o script com sudo, ou junta-te ao grupo docker:"
  echo "  sudo usermod -aG docker \$USER   (depois sai e volta a entrar)"
  exit 1
fi

mkdir -p "$PASTA"
cd "$PASTA"
echo "A descarregar a configuração para $(pwd)…"
curl -fsSL "$REPO/docker-compose.yml" -o docker-compose.yml
curl -fsSL "$REPO/Caddyfile" -o Caddyfile

if [ ! -f .env ]; then
  echo
  echo "Vamos configurar a app. (Instruções do ID do Google: https://github.com/catuta0/caixa-da-casa#passo-3-criar-o-id-de-cliente-do-google)"
  printf "Domínio da app, sem https:// (ex.: caixa.minhacasa.pt): "
  read -r DOMINIO </dev/tty
  printf "ID de cliente do Google (termina em .apps.googleusercontent.com): "
  read -r GOOGLE_CLIENT_ID </dev/tty
  printf "O teu email Google (ficas logo tesoureiro; podes deixar vazio): "
  read -r TESOUREIRO_EMAIL </dev/tty
  printf "Nome da casa [Casa comunitária]: "
  read -r NOME_CASA </dev/tty
  DOMINIO=$(printf "%s" "$DOMINIO" | sed -e 's#^https*://##' -e 's#/*$##')
  cat > .env <<EOF
DOMINIO=$DOMINIO
GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID
TESOUREIRO_EMAIL=$TESOUREIRO_EMAIL
NOME_CASA=${NOME_CASA:-Casa comunitária}
EOF
  chmod 600 .env
  echo "Configuração guardada em $(pwd)/.env"
else
  echo "Já existe um .env; mantenho a configuração atual."
fi

echo
echo "A descarregar a imagem e a arrancar…"
docker compose pull
docker compose up -d

DOMINIO=$(grep '^DOMINIO=' .env | cut -d= -f2-)
echo
echo "Pronto! Daqui a um minuto abre https://$DOMINIO, carrega em «Entrar como tesoureiro» e entra com a tua conta Google."
echo "Depois manda esse link às pessoas da casa: para ver e registar compras não precisam de conta."
echo "Para ver o que se passa: cd $(pwd) && docker compose logs -f"
