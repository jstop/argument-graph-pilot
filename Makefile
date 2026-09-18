# Convenience only; every target is a one-liner you can run by hand.
MODE ?= local

install:            ## node dependencies (signify-ts is vendored; no network tricks needed)
	npm install

stack:              ## Veridian's witnesses + KERIA (MODE=local|cloud)
	MODE=$(MODE) ./infra/stack.sh up

services:           ## our issuer + relying party, as containers next to the stack
	./infra/services.sh up

test:               ## unit + integration tests; integration needs `make stack`
	npm test

schema:             ## recompute the schema SAID after editing schema/*.source.json
	npx tsx schema/saidify.ts

down:               ## stop everything, keep data
	./infra/services.sh down; MODE=$(MODE) ./infra/stack.sh down

wipe:               ## stop everything and DELETE all data (identifiers, keys, claims)
	./infra/services.sh wipe; MODE=$(MODE) ./infra/stack.sh wipe

check:              ## what CI's fast job runs: secret scan, types, vectors, recorded-log verifier
	./ops/secret-scan.sh --history && npx tsc --noEmit -p . && npm test -w common && (cd verifier && python -m pytest -q)

help:
	@grep -E '^[a-z]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*##/  —/'
.PHONY: check install stack services test schema down wipe help
