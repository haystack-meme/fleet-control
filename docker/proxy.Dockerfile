# HTTPS in front of fleet-server. On first start it makes a self-signed certificate (kept in the `certs` volume).
FROM nginx:1.30.8-alpine
RUN apk add --no-cache openssl
COPY docker/selfsigned-cert.sh /docker-entrypoint.d/10-selfsigned-cert.sh
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
RUN chmod +x /docker-entrypoint.d/10-selfsigned-cert.sh
