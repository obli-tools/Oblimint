<?php
// Oblimint — BUILD-TIME test double of the panel's internal listener
// (POST /internal/dbadmin/redeem), served by `php -S` during the image build
// (RUN --mount, never copied into the image). See redeem-selftest.php.
declare(strict_types=1);

const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const GOOD = 'GoodToken_GoodToken_GoodToken_GoodToken_abc';

header('Content-Type: application/json');
if ($_SERVER['REQUEST_METHOD'] !== 'POST' || $_SERVER['REQUEST_URI'] !== '/internal/dbadmin/redeem') {
    http_response_code(404);
    echo '{"error":"not found"}';
    return;
}
if (($_SERVER['HTTP_X_OBLIMINT_DBADMIN_KEY'] ?? '') !== KEY || ($_SERVER['CONTENT_TYPE'] ?? '') !== 'application/json') {
    http_response_code(403);
    echo '{"error":"forbidden"}';
    return;
}
$in = json_decode((string) file_get_contents('php://input'), true);
if (!is_array($in) || ($in['token'] ?? null) !== GOOD) {
    http_response_code(404);
    echo '{"error":"unknown token"}';
    return;
}
echo json_encode([
    'engine' => 'mariadb',
    'host' => 'db-12',
    'port' => 3306,
    'user' => 'oblsso_0123abcd',
    'password' => 'p@ss "word"',
    'database' => 'shop',
    'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', time() + 600),
]);
