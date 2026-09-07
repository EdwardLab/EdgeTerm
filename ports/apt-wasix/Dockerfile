FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends \
        binaryen \
        autoconf \
        automake \
        autopoint \
        ca-certificates \
        clang \
        cmake \
        dpkg-dev \
        gettext \
        git \
        libclang-rt-18-dev-wasm32 \
        lld \
        llvm \
        libtool \
        make \
        ninja-build \
        patch \
        perl \
        pkg-config \
        triehash \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /work
