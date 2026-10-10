import { field, type BuiltinTemplate } from './types';

export const gitea: BuiltinTemplate = {
  slug: 'gitea',
  name: 'Gitea',
  icon: 'git-branch',
  category: 'devtools',
  description: 'Self-hosted Git service (rootless image, SQLite). Git over HTTPS through a proxy host.',
  docsUrl: 'https://docs.gitea.com/',
  version: '1.22.2-1',
  defaultProxy: { service: 'gitea', port: 3000 },
  minMemoryMb: 256,
  enabled: true,
  fields: [
    field({ key: 'GITEA_DOMAIN', label: 'Domain of the instance', type: 'domain', required: true, description: 'e.g. git.example.com' }),
  ],
  composeYaml: `services:
  gitea:
    image: gitea/gitea:1.22.2-rootless
    restart: unless-stopped
    ports: ["3000"]
    environment:
      GITEA__database__DB_TYPE: sqlite3
      GITEA__server__DOMAIN: \${GITEA_DOMAIN:?}
      GITEA__server__ROOT_URL: https://\${GITEA_DOMAIN:?}/
      GITEA__server__DISABLE_SSH: "true"
    volumes:
      - data:/var/lib/gitea
      - config:/etc/gitea
    deploy:
      resources:
        limits: {cpus: "1", memory: 512m}
volumes:
  data: {}
  config: {}
`,
};
