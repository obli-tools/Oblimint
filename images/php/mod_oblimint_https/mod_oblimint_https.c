/*
 * mod_oblimint_https: TLS ends at the edge (oblimint-edge), the site's Apache
 * only sees plain HTTP. SetEnvIf X-Forwarded-Proto HTTPS=on fixes PHP's
 * $_SERVER['HTTPS'] but not mod_rewrite's %{HTTPS} (connection-level, asked
 * to mod_ssl), so the very common .htaccess rule
 *     RewriteCond %{HTTPS} off
 *     RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301]
 * redirects forever. CWP gets away with it through mod_rpaf (RPAF_SetHTTPS).
 *
 * For a request forwarded with X-Forwarded-Proto: https by a peer of the
 * private account network, the connection is reported as TLS (%{HTTPS} on),
 * the scheme is https and the default port 443 (%{SERVER_PORT}, self
 * referential URLs). The flag is set for each request: the requests of a
 * keep-alive connection are handled one after the other.
 *
 * Apache >= 2.4.49 asks the ssl_conn_is_ssl hook (http_ssl.h); older Apache
 * (the Alpine 3.8 of the PHP 5.6 base) asks the ssl_is_https optional
 * function that mod_ssl would register (mod_ssl is never loaded here).
 */
#include "httpd.h"
#include "http_config.h"
#include "http_protocol.h"
#include "http_request.h"
#if defined(__has_include)
# if __has_include("http_ssl.h")
#  include "http_ssl.h"
#  define OBLIMINT_SSL_HOOK 1
# endif
#endif
#include "apr_network_io.h"
#include "apr_optional.h"
#include "apr_strings.h"

module AP_MODULE_DECLARE_DATA oblimint_https_module;

static const char *const trusted_nets[] = { "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "fc00::/7", "::1/128" };

typedef struct { int https; } conn_state;

static int peer_trusted(conn_rec *c)
{
    apr_size_t i;
    for (i = 0; i < sizeof(trusted_nets) / sizeof(trusted_nets[0]); i++) {
        char *ip = apr_pstrdup(c->pool, trusted_nets[i]);
        char *mask = strchr(ip, '/');
        apr_ipsubnet_t *net;
        *mask++ = '\0';
        if (apr_ipsubnet_create(&net, ip, mask, c->pool) == APR_SUCCESS && apr_ipsubnet_test(net, c->client_addr)) return 1;
    }
    return 0;
}

static conn_state *state_of(conn_rec *c)
{
    conn_state *s = ap_get_module_config(c->conn_config, &oblimint_https_module);
    if (!s) {
        s = apr_pcalloc(c->pool, sizeof(*s));
        ap_set_module_config(c->conn_config, &oblimint_https_module, s);
    }
    return s;
}

static int is_https(const request_rec *r)
{
    conn_state *s;
    if (!r) return 0;
    s = ap_get_module_config(r->connection->conn_config, &oblimint_https_module);
    return s && s->https;
}

static int post_read_request(request_rec *r)
{
    const char *proto = apr_table_get(r->headers_in, "X-Forwarded-Proto");
    state_of(r->connection)->https = proto && !strcasecmp(proto, "https") && peer_trusted(r->connection);
    return DECLINED;
}

#ifdef OBLIMINT_SSL_HOOK
static int conn_is_ssl(conn_rec *c)
{
    conn_state *s = ap_get_module_config(c->conn_config, &oblimint_https_module);
    return s && s->https ? OK : DECLINED;
}
#else
APR_DECLARE_OPTIONAL_FN(int, ssl_is_https, (conn_rec *));

static int ssl_is_https(conn_rec *c)
{
    conn_state *s = ap_get_module_config(c->conn_config, &oblimint_https_module);
    return s && s->https;
}
#endif

static const char *http_scheme(const request_rec *r)
{
    return is_https(r) ? "https" : NULL;
}

static apr_port_t default_port(const request_rec *r)
{
    return is_https(r) ? 443 : 0;
}

static void register_hooks(apr_pool_t *p)
{
    ap_hook_post_read_request(post_read_request, NULL, NULL, APR_HOOK_REALLY_FIRST);
#ifdef OBLIMINT_SSL_HOOK
    ap_hook_ssl_conn_is_ssl(conn_is_ssl, NULL, NULL, APR_HOOK_MIDDLE);
#else
    APR_REGISTER_OPTIONAL_FN(ssl_is_https);
#endif
    ap_hook_http_scheme(http_scheme, NULL, NULL, APR_HOOK_MIDDLE);
    ap_hook_default_port(default_port, NULL, NULL, APR_HOOK_MIDDLE);
}

AP_DECLARE_MODULE(oblimint_https) = {
    STANDARD20_MODULE_STUFF, NULL, NULL, NULL, NULL, NULL, register_hooks
};
