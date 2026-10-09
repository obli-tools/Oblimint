dnl oblimint_exec — PHP is only compiled from oblimint.exec_dirs (see oblimint_exec.c).
dnl Built in images/php/Dockerfile: phpize && ./configure --enable-oblimint-exec && make install

PHP_ARG_ENABLE([oblimint-exec],
  [whether to enable oblimint_exec],
  [AS_HELP_STRING([--enable-oblimint-exec], [Enable the oblimint_exec compile guard])],
  [no])

if test "$PHP_OBLIMINT_EXEC" != "no"; then
  PHP_NEW_EXTENSION(oblimint_exec, oblimint_exec.c, $ext_shared)
fi
