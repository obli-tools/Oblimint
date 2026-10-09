<?php
// Oblimint — router of the PHP built-in server (php -S … router.php): every
// path (the edge forwards /adminer/…) is served by the SSO wrapper; Adminer
// serves its own assets through ?file=. Nothing else in the directory is
// reachable directly (adminer.php, oblimint-redeem.php).
declare(strict_types=1);

require __DIR__ . '/oblimint.php';
