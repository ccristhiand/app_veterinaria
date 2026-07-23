'use strict';

const { backupTodos } = require('./backup.job');

const HORA_DIARIO   = process.env.BACKUP_HORA_DIARIO   || '02:00';
const HORA_SEMANAL  = process.env.BACKUP_HORA_SEMANAL  || '03:00';
const HORA_MENSUAL  = process.env.BACKUP_HORA_MENSUAL  || '04:00';

let timers = [];

function msHasta(horaStr) {
  const [h, m]   = horaStr.split(':').map(Number);
  const objetivo = new Date();
  objetivo.setHours(h, m, 0, 0);
  if (objetivo <= new Date()) objetivo.setDate(objetivo.getDate() + 1);
  return objetivo - new Date();
}

function programarDiario(hora, fn) {
  const delay = msHasta(hora);
  const mins  = Math.round(delay / 60000);
  console.log(`[scheduler] Programado en ${mins} min (${hora})`);

  const t = setTimeout(() => {
    fn();
    const i = setInterval(fn, 24 * 60 * 60 * 1000);
    timers.push(i);
  }, delay);
  timers.push(t);
}

function iniciarBackupScheduler() {
  // Diario
  programarDiario(HORA_DIARIO, () => {
    console.log('[scheduler] Ejecutando backup DIARIO…');
    backupTodos('diario').catch(e => console.error('[scheduler]', e.message));
  });

  // Semanal — solo los domingos
  programarDiario(HORA_SEMANAL, () => {
    if (new Date().getDay() === 0) {
      console.log('[scheduler] Ejecutando backup SEMANAL…');
      backupTodos('semanal').catch(e => console.error('[scheduler]', e.message));
    }
  });

  // Mensual — solo el día 1
  programarDiario(HORA_MENSUAL, () => {
    if (new Date().getDate() === 1) {
      console.log('[scheduler] Ejecutando backup MENSUAL…');
      backupTodos('mensual').catch(e => console.error('[scheduler]', e.message));
    }
  });

  console.log('[scheduler] ✅ Backup scheduler iniciado');
}

function detenerBackupScheduler() {
  timers.forEach(t => clearTimeout(t));
  timers = [];
}

module.exports = { iniciarBackupScheduler, detenerBackupScheduler };