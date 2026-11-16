# syntax=docker/dockerfile:1
# Postgres for SpainAssist: the official image plus pgvector, which the feedback server's hybrid
# search needs (services/feedback-server/README.md, "Search"). Built on the same Alpine image
# production already ran: a Debian image (pgvector's own) sorts text differently, which would
# corrupt the existing indexes on text columns.
#
#   docker build -t spainassistant/postgres:local infra/postgres
#
# .github/workflows/postgres-image.yml builds and publishes it; production pins the published
# digest (infra/terraform/coolify.tf).
ARG POSTGRES_IMAGE=postgres:17.11-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b

FROM ${POSTGRES_IMAGE} AS build
# pgvector by commit: a tag can move, a commit can't. The version names the published image.
ARG PGVECTOR_VERSION=0.8.7
ARG PGVECTOR_COMMIT=f37c13f68b57d2c3472b2214fbcff699d6d34876
RUN apk add --no-cache build-base git
WORKDIR /src
RUN git init -q . \
 && git fetch -q --depth 1 https://github.com/pgvector/pgvector.git "$PGVECTOR_COMMIT" \
 && git checkout -q FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = "$PGVECTOR_COMMIT" \
 && grep -qx "default_version = '$PGVECTOR_VERSION'" vector.control
# OPTFLAGS="": no -march=native, so the library runs on any x86-64 or arm64 machine, not only
# on the CPU that built it. with_llvm=no: no JIT bitcode, which would need the exact clang the
# base image was built with.
# trusted: the owner of a database may create the extension, so the feedback server's own role
# installs it with its migration and no superuser has to.
RUN echo "trusted = true" >> vector.control \
 && make OPTFLAGS="" with_llvm=no \
 && make install OPTFLAGS="" with_llvm=no DESTDIR=/out

FROM ${POSTGRES_IMAGE}
COPY --from=build /out/ /
