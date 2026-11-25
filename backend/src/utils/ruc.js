'use strict';

/** RUC peruano: 11 dígitos, empieza en 10/15/16/17/20 y dígito verificador (módulo 11) correcto */
function rucValido(ruc) {
  ruc = String(ruc || '');
  if (!/^(10|15|16|17|20)\d{9}$/.test(ruc)) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma  = pesos.reduce((a, p, i) => a + p * Number(ruc[i]), 0);
  return (11 - (suma % 11)) % 10 === Number(ruc[10]);   // resto 11 → 1 y 10 → 0
}

module.exports = { rucValido };
