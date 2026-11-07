# syntax=docker/dockerfile:1
#
# Single-binary image for tipd. Build from the repository root:
#   docker build -f deploy/Dockerfile -t tip/tipd:dev .
#
# Stage 1 builds the SPA, stage 2 embeds it into the Go binary (go:embed of
# backend/web/dist), the final stage is distroless/static running as non-root.

ARG NODE_VERSION=22
ARG GO_VERSION=1.27

# ---------------------------------------------------------------- frontend --
FROM node:${NODE_VERSION}-alpine AS web
WORKDIR /src

# The whole context is copied (it is already trimmed by .dockerignore) instead
# of package*.json first: COPY of a missing path fails, and the frontend may
# not exist yet. The npm download cache is kept by a cache mount instead.
COPY . /src/

RUN --mount=type=cache,target=/root/.npm \
    set -eu; \
    mkdir -p /out/dist; \
    if [ -f frontend/package.json ]; then \
      cd frontend; \
      npm ci; \
      npm run build; \
      cp -r dist/. /out/dist/; \
    else \
      echo "frontend/ not found: embedding a placeholder page" >&2; \
      echo '<!doctype html><title>TIP</title><p>Frontend is not built into this image.</p>' > /out/dist/index.html; \
    fi

# ----------------------------------------------------------------- backend --
FROM golang:${GO_VERSION}-alpine AS build
WORKDIR /src/backend

# go.sum may not exist while there are no dependencies yet, hence the glob.
COPY backend/go.mod backend/go.sum* ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download

COPY backend/ ./
# Replace any stale output with the freshly built SPA (go:embed target).
RUN rm -rf web/dist && mkdir -p web
COPY --from=web /out/dist ./web/dist

ARG VERSION=dev
ARG COMMIT=unknown
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux go build -trimpath \
      -ldflags "-s -w -X main.version=${VERSION} -X main.commit=${COMMIT}" \
      -o /out/tipd ./cmd/tipd

# Distroless has no shell: prepare the data directory here.
RUN mkdir -p /out/data/uploads /out/data/tmp

# ------------------------------------------------------------------- final --
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/tipd /tipd
# A named volume mounted on /data inherits this ownership (65532 = nonroot).
COPY --from=build --chown=65532:65532 /out/data /data

ENV DATA_DIR=/data HTTP_ADDR=:8080 INTERNAL_ADDR=:9090
USER 65532:65532
EXPOSE 8080 9090
ENTRYPOINT ["/tipd"]
