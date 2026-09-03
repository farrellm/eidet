# eidet — see DESIGN.md for what any of this means.
.PHONY: dev web server build test e2e typecheck deploy clean

# Ports: 5175 web, 8083 server, 8091 deployed. 5173/5174/5176 and 8080-8082/8090
# belong to other projects on this machine.
export EIDET_PORT ?= 8083
export EIDET_DATA ?= ./data

dev:                       ## web + server together
	@$(MAKE) -j2 web server

web:
	cd web && pnpm dev

server:
	cd server && pnpm dev

build:                     ## production bundle + service worker
	cd web && pnpm build

test:                      ## unit tests across every package
	pnpm -r --if-present test

e2e: build                 ## offline/PWA suite against a real production build
	cd web && pnpm e2e

typecheck:
	pnpm -r --if-present typecheck

check: typecheck test      ## everything short of e2e

deploy: build              ## push to the tailnet instance on :8091
	systemctl --user restart eidet
	@echo "restarted; logs: journalctl --user -u eidet -f"

clean:
	rm -rf web/dist web/.e2e-data web/test-results
