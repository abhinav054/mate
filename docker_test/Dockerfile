FROM node:20-slim

ARG PACKAGE_SPEC="/tmp/mate-package"
ARG RELEASE_CACHE_KEY="$PACKAGE_SPEC"

ENV MATE_HOME="/root/.mate"

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

COPY [".", "/tmp/mate-package"]

RUN set -eux; \
    echo "$RELEASE_CACHE_KEY" > /tmp/mate-release-cache-key; \
    npm install -g "$PACKAGE_SPEC"; \
    mkdir -p "$MATE_HOME"; \
    test -x "$(command -v mate)"; \
    node --check "$(npm root -g)/mate/src/main.js"

COPY ["docker_test/docker-entrypoint.sh", "/usr/local/bin/mate-docker-entrypoint"]
RUN chmod +x /usr/local/bin/mate-docker-entrypoint

WORKDIR /workspace

ENTRYPOINT ["mate-docker-entrypoint"]
CMD ["bash", "-lc", "test -x $(command -v mate) && node --check $(npm root -g)/mate/src/main.js && echo 'Mate npm global install smoke test passed.'"]
