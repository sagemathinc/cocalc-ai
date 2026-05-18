set -ev
cd ..

pnpm dev:hub:build
pnpm dev:hub:restart
pnpm dev:hosts:upgrade
