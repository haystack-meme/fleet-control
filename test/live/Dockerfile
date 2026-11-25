# A disposable "machine" for the live tests: Ubuntu with systemd as PID 1 and Node.js.
FROM ubuntu:24.04
ARG NODE_VERSION
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus curl ca-certificates python3 openssl xz-utils procps iproute2 libatomic1 \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" | tar -xJ -C /usr/local --strip-components=1 \
 && systemctl mask getty.target console-getty.service systemd-firstboot.service systemd-udevd.service systemd-resolved.service \
 && useradd --create-home tester
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
