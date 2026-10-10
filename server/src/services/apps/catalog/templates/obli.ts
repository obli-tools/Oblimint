import { field, secretField, type BuiltinTemplate } from './types';

// Obli applications (docs/P4b-PLAN.md §5.4): published as meejay/<app> images when available. Their public
// availability and runtime contract (port, DATABASE_URL) are NOT verified from this dev box: the templates
// ship DISABLED (enabled: false) until checked on the Linux test host, then a platform admin enables them
// (PATCH enabled on the built-in). The image is pinned by the version tag the user chooses (APP_VERSION,
// never :latest).

function obliApp(slug: string, name: string, icon: string, description: string, port: number): BuiltinTemplate {
  return {
    slug,
    name,
    icon,
    category: 'obli',
    description,
    docsUrl: null,
    version: '1.0.0-2',
    defaultProxy: { service: 'app', port },
    minMemoryMb: 512,
    enabled: false,
    fields: [
      field({ key: 'PUBLIC_URL', label: 'Public URL', type: 'url', required: true }),
      field({
        key: 'APP_VERSION', label: 'Version (image tag)', type: 'string', required: true,
        description: 'Published version of the image, e.g. 1.4.2 (latest is not accepted).',
        pattern: '^v?[0-9]{1,4}(\\.[0-9]{1,4})?(\\.[0-9]{1,4})?(-[0-9A-Za-z.]{1,32})?$',
      }),
      secretField('DB_PASSWORD', 'Database password'),
      secretField('SESSION_SECRET', 'Session secret', 'hex32'),
    ],
    composeYaml: `services:
  app:
    image: meejay/${slug}:\${APP_VERSION:?}
    restart: unless-stopped
    ports: ["${port}"]
    environment:
      NODE_ENV: production
      PORT: "${port}"
      PUBLIC_URL: \${PUBLIC_URL:?}
      DATABASE_URL: postgres://${slug}:\${DB_PASSWORD:?}@db:5432/${slug}
      SESSION_SECRET: \${SESSION_SECRET:?}
    depends_on:
      db:
        condition: service_healthy
    deploy:
      resources:
        limits: {cpus: "0.5", memory: 512m}
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: ${slug}
      POSTGRES_USER: ${slug}
      POSTGRES_PASSWORD: \${DB_PASSWORD:?}
    volumes:
      - db_data:/var/lib/postgresql/data
    cap_add: [CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${slug}"]
      interval: 10s
      timeout: 5s
      retries: 10
    deploy:
      resources:
        limits: {cpus: "0.5", memory: 384m}
volumes:
  db_data: {}
`,
  };
}

export const obliTemplates: BuiltinTemplate[] = [
  obliApp('obliview', 'Obliview', 'eye', 'Obli monitoring dashboards.', 3001),
  obliApp('obliguard', 'Obliguard', 'shield-check', 'Obli security and ban hub.', 3002),
  obliApp('oblimap', 'Oblimap', 'map', 'Obli network mapping.', 3003),
  obliApp('obliance', 'Obliance', 'monitor', 'Obli device management.', 3004),
  obliApp('oblihub', 'Oblihub', 'boxes', 'Obli Docker and proxy hub.', 3005),
];
