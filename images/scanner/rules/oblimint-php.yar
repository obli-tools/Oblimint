/*
 * Oblimint — YARA rules for PHP web applications (images/scanner, docs/P3-PLAN.md §9).
 *
 * Our OWN rule set, written in the spirit of php-malware-finder (no code
 * copied): dangerous execution fed by decoders or by the request, obfuscation,
 * known webshell families, uploaders, spam mailers, SEO spam / JS injectors.
 * Compiled with yarac at image build time (images/scanner/Dockerfile) and
 * exercised by tests/run-tests.sh on encoded samples.
 *
 * meta.score    risk points the panel gives a match (0 … 100,
 *               server/src/services/scan/scoring.ts; critical from 60)
 * meta.severity informational (the panel derives the severity from the score)
 *
 * Constraints of the YARA regex dialect: no look-around, no back-reference,
 * no (?:…) group; every string must be referenced by the condition.
 */

private rule OblimintPhpFile
{
    strings:
        $open = "<?php" nocase
        $short = "<?="
    condition:
        any of them
}

// ── execution of decoded / remote / request data ───────────────────────────

rule Oblimint_Php_Eval_Decoder : php obfuscation
{
    meta:
        description = "eval() of decoded data (base64_decode, gzinflate, str_rot13…)"
        score = 70
        severity = "critical"
    strings:
        $a = /eval\s*\(\s*(base64_decode|gzinflate|gzuncompress|gzdecode|str_rot13|strrev|hex2bin|convert_uudecode|rawurldecode)\s*\(/ nocase
    condition:
        OblimintPhpFile and $a
}

rule Oblimint_Php_Assert_Decoder : php obfuscation
{
    meta:
        description = "assert() of decoded data"
        score = 70
        severity = "critical"
    strings:
        $a = /assert\s*\(\s*(base64_decode|gzinflate|gzuncompress|gzdecode|str_rot13|strrev|hex2bin)\s*\(/ nocase
    condition:
        OblimintPhpFile and $a
}

rule Oblimint_Php_Request_Eval : php webshell
{
    meta:
        description = "eval() / assert() of request input"
        score = 90
        severity = "critical"
    strings:
        $a = /(eval|assert)\s*\(\s*(@\s*)?(stripslashes\s*\(\s*|trim\s*\(\s*)?\$_(GET|POST|REQUEST|COOKIE|SERVER)/ nocase
    condition:
        OblimintPhpFile and $a
}

rule Oblimint_Php_Remote_Eval : php backdoor
{
    meta:
        description = "eval() of remotely fetched code"
        score = 80
        severity = "critical"
    strings:
        $a = /(eval|assert)\s*\(\s*(@\s*)?(file_get_contents|curl_exec|stream_get_contents|fread)\s*\(/ nocase
        $b = /eval\s*\(\s*['"]\?>['"]\s*\.\s*(file_get_contents|base64_decode|gzinflate)/ nocase
    condition:
        OblimintPhpFile and any of them
}

rule Oblimint_Php_Preg_Replace_E : php
{
    meta:
        description = "preg_replace() with the /e (code execution) modifier"
        score = 70
        severity = "critical"
    strings:
        $slash = /preg_replace\s*\(\s*['"]\/[^\/'"\n]{0,300}\/[a-zA-Z]{0,8}e[a-zA-Z]{0,8}['"]/
        $hash = /preg_replace\s*\(\s*['"]#[^#'"\n]{0,300}#[a-zA-Z]{0,8}e[a-zA-Z]{0,8}['"]/
        $tilde = /preg_replace\s*\(\s*['"]~[^~'"\n]{0,300}~[a-zA-Z]{0,8}e[a-zA-Z]{0,8}['"]/
        $at = /preg_replace\s*\(\s*['"]@[^@'"\n]{0,300}@[a-zA-Z]{0,8}e[a-zA-Z]{0,8}['"]/
        $bang = /preg_replace\s*\(\s*['"]![^!'"\n]{0,300}![a-zA-Z]{0,8}e[a-zA-Z]{0,8}['"]/
    condition:
        OblimintPhpFile and any of them
}

rule Oblimint_Php_Create_Function_Decoder : php obfuscation
{
    meta:
        description = "create_function() built from decoded data"
        score = 60
        severity = "critical"
    strings:
        $a = /create_function\s*\([^;\n]{0,200}(base64_decode|gzinflate|str_rot13|hex2bin)\s*\(/ nocase
    condition:
        OblimintPhpFile and $a
}

rule Oblimint_Php_Request_Shell : php webshell
{
    meta:
        description = "Shell command taken from the request"
        score = 80
        severity = "critical"
    strings:
        $a = /\b(system|exec|passthru|shell_exec|popen|proc_open|pcntl_exec)\s*\(\s*(@\s*)?(stripslashes\s*\(\s*|base64_decode\s*\(\s*|trim\s*\(\s*)?\$_(GET|POST|REQUEST|COOKIE|SERVER)/ nocase
        /*
         * Backtick operator on request input (`$_GET['c']`). YARA scans raw
         * bytes, comments included, and Markdown-style PHPDoc writes request
         * keys exactly that way (WordPress core: "Defaults to `$_POST['user_login']`",
         * "usually coming from `$_POST['customized']`"…), so a bare
         * /`\s*\$_GET\[/ flags stock WordPress as a critical webshell.
         * The backtick must therefore sit in CODE position:
         *  - on a line that is not a comment line (first non-blank character
         *    is not '*', '/' or '#': docblock / line / hash comments), with no
         *    '/' or '#' between the line start and the backtick (trailing
         *    comments), and
         *  - right after an expression-introducing token (= ( . , ? : ; { [
         *    echo print return) or at the very start of the statement line.
         * Prose such as "from `$_POST[…]`" in a block comment is not matched.
         */
        $tick = /(\n|<\?php|<\?=)[ \t]*(([^ \t\r\n*\/#`][^\r\n`\/#]{0,200})?(=|\(|\.|,|\?|:|;|\{|\[|\becho|\bprint|\breturn))?[ \t]*`\s*\$_(GET|POST|REQUEST|COOKIE)\s*\[/ nocase
    condition:
        OblimintPhpFile and any of them
}

rule Oblimint_Php_Request_Include : php
{
    meta:
        description = "include / require of a request-supplied path"
        score = 70
        severity = "critical"
    strings:
        $a = /\b(include|require|include_once|require_once)\s*\(?\s*(@\s*)?\$_(GET|POST|REQUEST|COOKIE)/ nocase
    condition:
        OblimintPhpFile and $a
}

rule Oblimint_Php_Request_Callable : php webshell
{
    meta:
        description = "Function name taken from the request"
        score = 70
        severity = "critical"
    strings:
        $direct = /\$_(GET|POST|REQUEST|COOKIE)\s*\[[^\]\n]{1,40}\]\s*\(/
        $cb = /\b(call_user_func|call_user_func_array|array_map|register_shutdown_function|register_tick_function)\s*\(\s*(@\s*)?\$_(GET|POST|REQUEST|COOKIE)/ nocase
    condition:
        OblimintPhpFile and any of them
}

rule Oblimint_Php_Reverse_Shell : php backdoor
{
    meta:
        description = "Reverse shell (socket connected to a shell)"
        score = 80
        severity = "critical"
    strings:
        $sock = /\b(fsockopen|socket_connect|stream_socket_client)\s*\(/ nocase
        $sh1 = "/bin/sh"
        $sh2 = "/bin/bash"
        $sh3 = "cmd.exe" nocase
        $pipe = /proc_open\s*\(\s*['"](\/bin\/sh|\/bin\/bash|sh|bash)/ nocase
    condition:
        OblimintPhpFile and $sock and (any of ($sh*) or $pipe)
}

// ── obfuscation ──────────────────────────────────────────────────────────────

rule Oblimint_Php_Decoder_Chain : php obfuscation
{
    meta:
        description = "Nested decoders (gzinflate(base64_decode(…)), str_rot13(base64_decode(…))…)"
        score = 50
        severity = "warn"
    strings:
        $a = /(gzinflate|gzuncompress|gzdecode|str_rot13|strrev)\s*\(\s*(base64_decode|str_rot13|strrev|gzinflate)\s*\(/ nocase
    condition:
        OblimintPhpFile and $a
}

rule Oblimint_Php_Long_Base64_Literal : php obfuscation
{
    meta:
        description = "base64_decode() of a very long literal"
        score = 50
        severity = "warn"
    strings:
        $a = /base64_decode\s*\(\s*['"][A-Za-z0-9+\/=]{1500,}/ nocase
    condition:
        OblimintPhpFile and $a
}

rule Oblimint_Php_Hex_Escapes : php obfuscation
{
    meta:
        description = "Long chain of \\xNN escapes"
        score = 40
        severity = "warn"
    strings:
        $hex = /(\\x[0-9a-fA-F]{2}){30,}/
        $oct = /(\\[0-7]{3}){30,}/
    condition:
        OblimintPhpFile and any of them
}

rule Oblimint_Php_Chr_Chain : php obfuscation
{
    meta:
        description = "Long chr() concatenation"
        score = 40
        severity = "warn"
    strings:
        $a = /(chr\s*\(\s*[0-9]{1,3}\s*\)\s*\.\s*){10,}/ nocase
    condition:
        OblimintPhpFile and $a
}

rule Oblimint_Php_Encoded_Globals : php obfuscation
{
    meta:
        description = "Function called through an encoded $GLOBALS / variable-variable name"
        score = 50
        severity = "warn"
    strings:
        $braces = /\$\{\s*['"]\\x[0-9a-fA-F]{2}/
        $globals = /\$GLOBALS\s*\[\s*['"][^'"\n]{1,40}['"]\s*\]\s*\[\s*[0-9]{1,4}\s*\]\s*\(/
        $concat = /\$GLOBALS\s*\[\s*['"][a-zA-Z0-9_]{1,10}['"]\s*\.\s*['"]/
    condition:
        OblimintPhpFile and any of them
}

rule Oblimint_Php_Obfuscated_Identifiers : php obfuscation
{
    meta:
        description = "Identifiers made of O/0 only (FOPO-style obfuscator)"
        score = 50
        severity = "warn"
    strings:
        $a = /\$[O0]{6,}[O0_]{0,20}/
    condition:
        OblimintPhpFile and #a > 10
}

rule Oblimint_Php_Rot13_Exec : php obfuscation
{
    meta:
        description = "str_rot13 / strrev next to dynamic execution"
        score = 40
        severity = "warn"
    strings:
        $rot = /(str_rot13|strrev)\s*\(\s*['"][a-zA-Z_]{4,20}['"]\s*\)/ nocase
        $exec = /\b(eval|assert|create_function|call_user_func)\s*\(/ nocase
    condition:
        OblimintPhpFile and $rot and $exec
}

rule Oblimint_Php_Packed_Js_In_Php : php injector
{
    meta:
        description = "Packed / encoded JavaScript emitted by PHP (injector)"
        score = 40
        severity = "warn"
    strings:
        $packer = "eval(function(p,a,c,k,e," nocase
        $unescape = /document\.write\s*\(\s*unescape\s*\(/ nocase
        $charcode = /String\.fromCharCode\s*\(\s*([0-9]{2,3}\s*,\s*){30,}/ nocase
    condition:
        OblimintPhpFile and any of them
}

rule Oblimint_Php_Write_Decoded_File : php dropper
{
    meta:
        description = "Writes decoded data to a file (dropper)"
        score = 50
        severity = "warn"
    strings:
        $a = /(file_put_contents|fwrite|fputs)\s*\([^;\n]{0,200}(base64_decode|gzinflate|str_rot13|hex2bin)\s*\(/ nocase
    condition:
        OblimintPhpFile and $a
}

rule Oblimint_Php_Shell_Hygiene : php
{
    meta:
        description = "Typical webshell preamble (no time limit, errors hidden, survives disconnects) with request input"
        score = 30
        severity = "warn"
    strings:
        $t = /set_time_limit\s*\(\s*0\s*\)/ nocase
        $u = /ignore_user_abort\s*\(\s*(1|true)?\s*\)/ nocase
        $e = /@?error_reporting\s*\(\s*0\s*\)/ nocase
        $d = /ini_set\s*\(\s*['"]display_errors['"]\s*,\s*['"]?(0|off)/ nocase
        $req = /\$_(POST|REQUEST|COOKIE)\s*\[/
    condition:
        OblimintPhpFile and $req and 3 of ($t, $u, $e, $d)
}

// ── known webshell families (markers) ───────────────────────────────────────

rule Oblimint_Webshell_C99 : webshell
{
    meta:
        description = "c99 / c100 webshell markers"
        score = 90
        severity = "critical"
    strings:
        $a = "c99shell" nocase
        $b = "c99_buff_prepare"
        $c = "c99sh_surl"
        $d = "c99_sess_put"
        $e = "c99ftpbrutecheck"
    condition:
        any of them
}

rule Oblimint_Webshell_R57 : webshell
{
    meta:
        description = "r57 webshell markers"
        score = 90
        severity = "critical"
    strings:
        $a = "r57shell" nocase
        $b = "r57_pwd_hash"
        $c = "r57 shell" nocase
        $d = /\$_POST\s*\[\s*['"]cmd['"]\s*\][^\n]{0,80}r57/ nocase
    condition:
        any of them
}

rule Oblimint_Webshell_B374k : webshell
{
    meta:
        description = "b374k webshell markers"
        score = 90
        severity = "critical"
    strings:
        $a = "b374k" nocase
        $b = "b374k_"
        $c = /\$GLOBALS\s*\[\s*['"]module_to_load['"]\s*\]/
    condition:
        any of them
}

rule Oblimint_Webshell_WSO : webshell
{
    meta:
        description = "WSO (Web Shell by oRb) markers"
        score = 90
        severity = "critical"
    strings:
        $ver = /WSO_VERSION|wso_version/
        $title = /WSO\s+[0-9]\.[0-9]/
        $fm = "FilesMan"
        $act = /\$default_action\s*=\s*['"]FilesMan['"]/
        $fn = /function\s+wso(Header|Footer|Login|Ex|Ex2|PermsColor|ScanDir|WhichR)\s*\(/
    condition:
        $ver or $title or $act or $fn or ($fm and #fm > 2)
}

rule Oblimint_Webshell_FilesMan : webshell
{
    meta:
        description = "FilesMan file manager marker (WSO and derivatives)"
        score = 70
        severity = "critical"
    strings:
        $a = "FilesMan"
    condition:
        OblimintPhpFile and $a
}

rule Oblimint_Webshell_Weevely : webshell
{
    meta:
        description = "weevely backdoor agent pattern"
        score = 90
        severity = "critical"
    strings:
        $kh = /\$kh\s*=\s*["'][0-9a-f]{8}["']/
        $kf = /\$kf\s*=\s*["'][0-9a-f]{8}["']/
        $re = /preg_match\s*\(\s*["']\/\$kh\(\.\+\)\$kf\//
    condition:
        OblimintPhpFile and (($kh and $kf) or $re)
}

rule Oblimint_Webshell_Generic_Ui : webshell
{
    meta:
        description = "Generic webshell user interface strings"
        score = 60
        severity = "critical"
    strings:
        $m1 = "Safe Mode Bypass" nocase
        $m2 = "safe_mode bypass" nocase
        $m3 = "PHP Shell" nocase
        $m4 = "Command execute" nocase
        $m5 = "Bind port to /bin/sh" nocase
        $m6 = "back connect" nocase
        $m7 = "uname -a"
        $m8 = "Self remove" nocase
        $m9 = "Upload file" nocase
        $req = /\$_(GET|POST|REQUEST|COOKIE)\s*\[/
    condition:
        OblimintPhpFile and $req and 3 of ($m*)
}

// ── uploaders, mailers, SEO spam ────────────────────────────────────────────

rule Oblimint_Php_Tiny_Uploader : php uploader
{
    meta:
        description = "Minimal file uploader (form + move_uploaded_file to a client-chosen name)"
        score = 50
        severity = "warn"
    strings:
        $form = /enctype\s*=\s*["']multipart\/form-data["']/ nocase
        $move = /move_uploaded_file\s*\(\s*\$_FILES\s*\[[^\]]{1,40}\]\s*\[\s*['"]tmp_name['"]\s*\]\s*,\s*[^;\n]{0,80}\$_FILES\s*\[[^\]]{1,40}\]\s*\[\s*['"]name['"]\s*\]/ nocase
    condition:
        OblimintPhpFile and filesize < 20KB and $form and $move
}

rule Oblimint_Php_Copy_Uploader : php uploader
{
    meta:
        description = "Writes a request-supplied payload to a request-supplied path"
        score = 60
        severity = "critical"
    strings:
        $a = /(file_put_contents|fopen)\s*\(\s*\$_(GET|POST|REQUEST|COOKIE)\s*\[[^\]\n]{1,40}\]\s*,\s*[^;\n]{0,60}\$_(GET|POST|REQUEST|COOKIE)/ nocase
        $b = /copy\s*\(\s*\$_(GET|POST|REQUEST)\s*\[[^\]\n]{1,40}\]\s*,/ nocase
    condition:
        OblimintPhpFile and any of them
}

rule Oblimint_Php_Spam_Mailer : php mailer
{
    meta:
        description = "Spam mailer (request-driven mail(), known mailer kits)"
        score = 60
        severity = "critical"
    strings:
        $leaf = "Leaf PHPMailer" nocase
        $leaf2 = "leafmailer" nocase
        $kit = /(Owl|Alexus|Pro)\s*Mailer\s*(v|Version)?\s*[0-9]/ nocase
        $req = /\bmail\s*\(\s*(@\s*)?\$_(GET|POST|REQUEST)/ nocase
        $bulk = /\$_POST\s*\[\s*['"](emailList|maillist|mail_list|emails)['"]\s*\]/ nocase
    condition:
        OblimintPhpFile and any of them
}

rule Oblimint_Php_Seo_Cloaking : php seo
{
    meta:
        description = "SEO spam cloaking (search-engine user agents served remote content)"
        score = 40
        severity = "warn"
    strings:
        $ua = "HTTP_USER_AGENT"
        $bot = /(googlebot|bingbot|yandex|baiduspider|slurp)/ nocase
        $remote = /(file_get_contents|curl_init)\s*\(\s*['"]https?:\/\//
        $out = /(echo|print|header\s*\(\s*['"]Location)/ nocase
    condition:
        OblimintPhpFile and $ua and $bot and $remote and $out and filesize < 200KB
}

rule Oblimint_Php_Spam_Link_Injector : php seo
{
    meta:
        description = "Hidden link / pharma spam injected in output"
        score = 40
        severity = "warn"
    strings:
        $hide = /<div\s+style\s*=\s*["'][^"']{0,40}(display\s*:\s*none|left\s*:\s*-[0-9]{3,}px)/ nocase
        $spam = /(viagra|cialis|casino|payday\s*loan|replica\s*watch)/ nocase
    condition:
        OblimintPhpFile and $hide and #spam > 3
}

// ── non-PHP carriers ─────────────────────────────────────────────────────────

rule Oblimint_Php_In_Image : polyglot
{
    meta:
        description = "Image file carrying PHP code (polyglot)"
        score = 80
        severity = "critical"
    strings:
        $php = "<?php" nocase
    condition:
        (uint16(0) == 0xD8FF or uint32(0) == 0x474E5089 or uint32(0) == 0x38464947) and $php
}

rule Oblimint_Htaccess_Php_Handler : htaccess
{
    meta:
        description = ".htaccess makes media / text files run as PHP"
        score = 60
        severity = "critical"
    strings:
        $add = /(AddType|AddHandler)\s+application\/x-httpd-php[0-9a-z_-]*\s+[^\n]{0,60}\.(jpe?g|png|gif|ico|txt|bmp|svg|webp)/ nocase
        $set = /<Files(Match)?\s+[^>\n]{0,80}\.(jpe?g|png|gif|ico|txt)[^>\n]{0,40}>\s*SetHandler\s+application\/x-httpd-php/ nocase
        $prepend = /php_value\s+auto_(prepend|append)_file\s+[^\n]{0,200}\.(jpe?g|png|gif|ico|txt|log)/ nocase
    condition:
        any of them
}
