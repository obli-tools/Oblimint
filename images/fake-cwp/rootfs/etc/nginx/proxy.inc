# /etc/nginx/proxy.inc — included by every CWP vhost (fake-cwp, TEST ONLY).
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_connect_timeout 300;
proxy_send_timeout 300;
proxy_read_timeout 300;
client_max_body_size 256m;
