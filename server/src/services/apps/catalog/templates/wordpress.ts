import { secretField, type BuiltinTemplate } from './types';

export const wordpress: BuiltinTemplate = {
  slug: 'wordpress',
  name: 'WordPress',
  icon: 'newspaper',
  category: 'cms',
  description: 'WordPress with its MariaDB database.',
  docsUrl: 'https://wordpress.org/documentation/',
  version: '6.6.2-1',
  defaultProxy: { service: 'wordpress', port: 80 },
  minMemoryMb: 1024,
  enabled: true,
  fields: [
    secretField('DB_PASSWORD', 'Database password'),
    secretField('DB_ROOT_PASSWORD', 'Database root password'),
  ],
  composeYaml: `services:
  wordpress:
    image: wordpress:6.6.2-php8.3-apache
    restart: unless-stopped
    ports: ["80"]
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_USER: wordpress
      WORDPRESS_DB_PASSWORD: \${DB_PASSWORD:?}
      WORDPRESS_DB_NAME: wordpress
    volumes:
      - wp_data:/var/www/html
    cap_add: [CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID, NET_BIND_SERVICE]
    depends_on:
      db:
        condition: service_healthy
    deploy:
      resources:
        limits: {cpus: "1", memory: 512m}
  db:
    image: mariadb:11.4
    restart: unless-stopped
    environment:
      MARIADB_DATABASE: wordpress
      MARIADB_USER: wordpress
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
volumes:
  wp_data: {}
  db_data: {}
`,
};
