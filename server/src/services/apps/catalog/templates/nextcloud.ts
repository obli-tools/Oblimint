import { field, secretField, type BuiltinTemplate } from './types';

export const nextcloud: BuiltinTemplate = {
  slug: 'nextcloud',
  name: 'Nextcloud',
  icon: 'cloud',
  category: 'productivity',
  description: 'Nextcloud (files, calendar, contacts) with MariaDB and Redis.',
  docsUrl: 'https://docs.nextcloud.com/',
  version: '29.0.7-1',
  defaultProxy: { service: 'nextcloud', port: 80 },
  minMemoryMb: 1536,
  enabled: true,
  fields: [
    field({ key: 'NEXTCLOUD_ADMIN_USER', label: 'Administrator login', type: 'string', required: true, default: 'admin', pattern: '^[A-Za-z0-9._-]{1,64}$' }),
    secretField('NEXTCLOUD_ADMIN_PASSWORD', 'Administrator password'),
    field({ key: 'NEXTCLOUD_TRUSTED_DOMAINS', label: 'Domain(s) of the instance', type: 'string', required: true, description: 'Space-separated, e.g. cloud.example.com', pattern: '^[A-Za-z0-9. -]{1,512}$' }),
    secretField('DB_PASSWORD', 'Database password'),
    secretField('DB_ROOT_PASSWORD', 'Database root password'),
    secretField('REDIS_PASSWORD', 'Redis password', 'hex32'),
  ],
  composeYaml: `services:
  nextcloud:
    image: nextcloud:29.0.7-apache
    restart: unless-stopped
    ports: ["80"]
    environment:
      MYSQL_HOST: db
      MYSQL_DATABASE: nextcloud
      MYSQL_USER: nextcloud
      MYSQL_PASSWORD: \${DB_PASSWORD:?}
      NEXTCLOUD_ADMIN_USER: \${NEXTCLOUD_ADMIN_USER:-admin}
      NEXTCLOUD_ADMIN_PASSWORD: \${NEXTCLOUD_ADMIN_PASSWORD:?}
      NEXTCLOUD_TRUSTED_DOMAINS: \${NEXTCLOUD_TRUSTED_DOMAINS:?}
      OVERWRITEPROTOCOL: https
      TRUSTED_PROXIES: 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16
      REDIS_HOST: redis
      REDIS_HOST_PASSWORD: \${REDIS_PASSWORD:?}
    volumes:
      - nc_data:/var/www/html
    cap_add: [CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID, NET_BIND_SERVICE]
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_started
    deploy:
      resources:
        limits: {cpus: "1", memory: 1g}
  db:
    image: mariadb:11.4
    restart: unless-stopped
    command: ["--transaction-isolation=READ-COMMITTED", "--log-bin=binlog", "--binlog-format=ROW"]
    environment:
      MARIADB_DATABASE: nextcloud
      MARIADB_USER: nextcloud
      MARIADB_PASSWORD: \${DB_PASSWORD:?}
      MARIADB_ROOT_PASSWORD: \${DB_ROOT_PASSWORD:?}
    volumes:
      - db_data:/var/lib/mysql
    cap_add: [CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID]
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 30s
    deploy:
      resources:
        limits: {cpus: "0.5", memory: 512m}
  redis:
    image: redis:7.4-alpine
    restart: unless-stopped
    command: ["redis-server", "--requirepass", "\${REDIS_PASSWORD:?}"]
    cap_add: [CHOWN, SETGID, SETUID]
    deploy:
      resources:
        limits: {cpus: "0.25", memory: 128m}
volumes:
  nc_data: {}
  db_data: {}
`,
};
