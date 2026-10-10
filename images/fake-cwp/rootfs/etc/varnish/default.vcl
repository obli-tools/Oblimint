# /etc/varnish/default.vcl — CentOS Web Panel (fake-cwp, TEST ONLY). Varnish is NOT installed nor running.
vcl 4.0;

backend default {
    .host = "203.0.113.10";
    .port = "8181";
}

include "/etc/varnish/conf.d/vhosts/shop.gamma.test.conf";
