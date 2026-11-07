/**
 * Eliminación de citas — modal compartido (citas.html y calendario.html)
 *
 * Uso: eliminarCita(id, { onEliminada: (id) => … })
 *
 * 1. Consulta GET /citas/:id/eliminable.
 * 2. Si la cita tuvo atención (consulta, estética, comprobante, en curso o completada)
 *    muestra el aviso "No se puede eliminar" con los motivos.
 * 3. Si no, pide confirmación (motivo opcional, queda en auditoría) y hace DELETE.
 */
(function () {
  const TIPOS = {
    medica         : { icon:'🩺', label:'Atención médica' },
    vacuna         : { icon:'💉', label:'Vacunación' },
    desparasitacion: { icon:'🪱', label:'Desparasitación' },
    estetica       : { icon:'✂️', label:'Estética' },
  };

  const ICONO_PAPELERA = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6M10 11v6M14 11v6"/></svg>';
  const ICONO_CANDADO  = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>';
  const ICONO_ALERTA   = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0zM12 9v4M12 17h.01"/></svg>';

  function estilos() {
    if (document.getElementById('__elim-cita-style')) return;
    const st = document.createElement('style');
    st.id = '__elim-cita-style';
    st.textContent = `
      #__elim-cita { position:fixed;inset:0;z-index:9998;background:rgba(15,23,20,.5);backdrop-filter:blur(2px);
        display:flex;align-items:center;justify-content:center;padding:1rem;animation:ecFade .15s ease; }
      #__elim-cita .ec-card { background:#fff;border-radius:1.25rem;width:100%;max-width:470px;overflow:hidden;
        box-shadow:0 24px 64px rgba(0,0,0,.18);animation:ecUp .2s ease;max-height:calc(100vh - 2rem);display:flex;flex-direction:column; }
      #__elim-cita .ec-head { padding:1.4rem 1.5rem 1rem;display:flex;gap:.9rem;align-items:flex-start; }
      #__elim-cita .ec-ico { flex-shrink:0;width:44px;height:44px;border-radius:999px;display:flex;align-items:center;justify-content:center; }
      #__elim-cita .ec-ico.danger { background:#ffe4e6;color:#e11d48;box-shadow:0 0 0 6px #fff1f2; }
      #__elim-cita .ec-ico.locked { background:#e2e8f0;color:#475569;box-shadow:0 0 0 6px #f1f5f9; }
      #__elim-cita .ec-title { font-weight:700;font-size:1.02rem;color:#1a2e28;margin:0; }
      #__elim-cita .ec-sub { font-size:.78rem;color:#6b7c76;margin-top:.2rem;line-height:1.45; }
      #__elim-cita .ec-body { padding:0 1.5rem 1.2rem;display:flex;flex-direction:column;gap:.85rem;overflow-y:auto; }
      #__elim-cita .ec-resumen { border:1px solid #e5ebe8;border-radius:.9rem;padding:.8rem .95rem;background:#fafbfa;
        display:grid;grid-template-columns:auto 1fr;gap:.3rem .8rem;font-size:.8rem; }
      #__elim-cita .ec-resumen dt { color:#94a5a0;font-weight:600; }
      #__elim-cita .ec-resumen dd { margin:0;color:#1a2e28;font-weight:500;min-width:0;overflow-wrap:anywhere; }
      #__elim-cita .ec-aviso { display:flex;gap:.55rem;align-items:flex-start;background:#fffbeb;border:1px solid #fde68a;
        color:#92400e;border-radius:.8rem;padding:.7rem .85rem;font-size:.76rem;line-height:1.5; }
      #__elim-cita .ec-aviso svg { flex-shrink:0;margin-top:.1rem; }
      #__elim-cita .ec-motivos { list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.4rem; }
      #__elim-cita .ec-motivos li { display:flex;gap:.55rem;align-items:flex-start;font-size:.8rem;color:#334155;
        background:#f8fafc;border:1px solid #e2e8f0;border-radius:.7rem;padding:.55rem .75rem; }
      #__elim-cita .ec-motivos li::before { content:'';flex-shrink:0;width:7px;height:7px;border-radius:99px;background:#94a3b8;margin-top:.42rem; }
      #__elim-cita .ec-nota { font-size:.74rem;color:#6b7c76;line-height:1.55; }
      #__elim-cita label.ec-label { font-size:.72rem;font-weight:600;color:#4b5f57;display:block;margin-bottom:.3rem; }
      #__elim-cita textarea { width:100%;border:1.5px solid #e5ebe8;border-radius:.75rem;padding:.55rem .7rem;font-family:inherit;
        font-size:.82rem;resize:vertical;min-height:58px;outline:none;transition:border-color .15s; }
      #__elim-cita textarea:focus { border-color:#fda4af;box-shadow:0 0 0 3px #fff1f2; }
      #__elim-cita .ec-foot { padding:.9rem 1.5rem;border-top:1px solid #f1f4f2;background:#fcfdfc;display:flex;justify-content:flex-end;gap:.6rem;flex-wrap:wrap; }
      #__elim-cita .ec-btn { padding:.6rem 1.2rem;border-radius:.75rem;font-size:.84rem;font-weight:700;cursor:pointer;font-family:inherit;
        display:inline-flex;align-items:center;gap:.4rem;transition:all .15s;border:1.5px solid transparent; }
      #__elim-cita .ec-btn-ghost { background:#fff;border-color:#e5e7eb;color:#374151; }
      #__elim-cita .ec-btn-ghost:hover { background:#f9fafb; }
      #__elim-cita .ec-btn-danger { background:#e11d48;color:#fff; }
      #__elim-cita .ec-btn-danger:hover { background:#be123c; }
      #__elim-cita .ec-btn-danger[disabled] { opacity:.65;cursor:wait; }
      #__elim-cita .ec-btn-dark { background:#1a2e28;color:#fff; }
      #__elim-cita .ec-cargando { padding:2.5rem 1.5rem;text-align:center;font-size:.82rem;color:#6b7c76; }
      @media (max-width:480px) { #__elim-cita .ec-foot .ec-btn { flex:1;justify-content:center; } }
      @keyframes ecFade { from{opacity:0} to{opacity:1} }
      @keyframes ecUp { from{transform:translateY(14px);opacity:0} to{transform:none;opacity:1} }`;
    document.head.appendChild(st);
  }

  function resumenCita(c) {
    const t = TIPOS[c.tipo_cita] || TIPOS.medica;
    return `
      <dl class="ec-resumen">
        <dt>Mascota</dt><dd>${badgeEspecie(c.especie)} <b>${esc(c.mascota_nombre)}</b></dd>
        <dt>Propietario</dt><dd>${esc(c.propietario_nombre || '—')}</dd>
        <dt>Fecha</dt><dd>${fDateTime(c.fecha_hora)}</dd>
        <dt>Tipo</dt><dd>${t.icon} ${t.label}</dd>
        <dt>Veterinario</dt><dd>${esc(c.veterinario_nombre || '—')}</dd>
        <dt>Motivo</dt><dd>${esc(c.motivo || '—')}</dd>
        <dt>Estado</dt><dd>${badgeEstado(c.estado)}</dd>
      </dl>`;
  }

  function abrirOverlay(html) {
    estilos();
    document.getElementById('__elim-cita')?.remove();
    const ov = document.createElement('div');
    ov.id = '__elim-cita';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.innerHTML = `<div class="ec-card">${html}</div>`;
    document.body.appendChild(ov);
    return ov;
  }

  function cerrar() {
    const ov = document.getElementById('__elim-cita');
    if (!ov) return;
    ov.style.transition = 'opacity .15s'; ov.style.opacity = '0';
    setTimeout(() => ov.remove(), 150);
    document.removeEventListener('keydown', onKey);
  }
  let _ocupado = false;
  function onKey(e) { if (e.key === 'Escape' && !_ocupado) cerrar(); }

  async function eliminarCita(id, opciones = {}) {
    _ocupado = false;
    const ov = abrirOverlay('<div class="ec-cargando"><div class="vspinner" style="margin:0 auto .7rem"></div>Verificando la cita…</div>');
    ov.addEventListener('click', e => { if (e.target === ov && !_ocupado) cerrar(); });
    document.addEventListener('keydown', onKey);

    let info;
    try {
      const res = await api(`/citas/${id}/eliminable`);
      if (!res) { cerrar(); return; }
      const json = await res.json();
      if (!res.ok) { cerrar(); apiError(res.status, json.message); return; }
      info = json.data;
    } catch { cerrar(); toast('Error de conexión.', 'danger'); return; }

    const card = ov.querySelector('.ec-card');

    // ── No se puede eliminar ──────────────────────────────────────
    if (!info.eliminable) {
      card.innerHTML = `
        <div class="ec-head">
          <div class="ec-ico locked">${ICONO_CANDADO}</div>
          <div>
            <p class="ec-title">No se puede eliminar esta cita</p>
            <p class="ec-sub">La cita #${info.cita.id} ya tiene una atención registrada.</p>
          </div>
        </div>
        <div class="ec-body">
          ${resumenCita(info.cita)}
          <ul class="ec-motivos">${info.motivos.map(m => `<li>${esc(m)}</li>`).join('')}</ul>
          <p class="ec-nota">Las citas atendidas forman parte del historial clínico de la mascota y se conservan
            para mantener la trazabilidad. Si se registró por error, corrige la atención o cambia el estado de la cita.</p>
        </div>
        <div class="ec-foot">
          <button class="ec-btn ec-btn-dark" data-a="ok">Entendido</button>
        </div>`;
      card.querySelector('[data-a="ok"]').onclick = cerrar;
      card.querySelector('[data-a="ok"]').focus();
      return;
    }

    // ── Confirmar eliminación ─────────────────────────────────────
    card.innerHTML = `
      <div class="ec-head">
        <div class="ec-ico danger">${ICONO_PAPELERA}</div>
        <div>
          <p class="ec-title">¿Eliminar la cita #${info.cita.id}?</p>
          <p class="ec-sub">Se quitará de la agenda y del calendario de forma definitiva.</p>
        </div>
      </div>
      <div class="ec-body">
        ${resumenCita(info.cita)}
        <div class="ec-aviso">${ICONO_ALERTA}
          <span><b>Esta acción no se puede deshacer.</b> Si el cliente solo no asistirá,
          es preferible marcar la cita como <b>cancelada</b> para conservar el registro.</span>
        </div>
        <div>
          <label class="ec-label" for="__ec-motivo">Motivo de la eliminación <span style="font-weight:400;color:#94a5a0">(opcional, queda en auditoría)</span></label>
          <textarea id="__ec-motivo" maxlength="200" placeholder="Ej.: Cita duplicada, registrada por error…"></textarea>
        </div>
      </div>
      <div class="ec-foot">
        <button class="ec-btn ec-btn-ghost" data-a="volver">Volver</button>
        <button class="ec-btn ec-btn-danger" data-a="eliminar">${ICONO_PAPELERA.replace(/width="22" height="22"/, 'width="16" height="16"')} Eliminar cita</button>
      </div>`;

    const btnElim = card.querySelector('[data-a="eliminar"]');
    card.querySelector('[data-a="volver"]').onclick = cerrar;
    card.querySelector('[data-a="volver"]').focus();

    btnElim.onclick = async () => {
      _ocupado = true;
      btnElim.disabled = true;
      btnElim.textContent = 'Eliminando…';
      try {
        const motivo = card.querySelector('#__ec-motivo').value.trim();
        const res = await api(`/citas/${id}`, { method:'DELETE', body: motivo ? { motivo } : undefined });
        if (!res) { _ocupado = false; cerrar(); return; }
        const json = await res.json();
        if (res.status === 409) {           // se atendió mientras el modal estaba abierto
          _ocupado = false;
          cerrar();
          return eliminarCita(id, opciones);
        }
        if (!res.ok) { _ocupado = false; cerrar(); apiError(res.status, json.message); return; }
        _ocupado = false;
        cerrar();
        toast(`🗑️ Cita #${id} eliminada`, 'success');
        if (typeof opciones.onEliminada === 'function') opciones.onEliminada(Number(id));
      } catch {
        _ocupado = false;
        btnElim.disabled = false;
        btnElim.textContent = 'Eliminar cita';
        toast('Error de conexión.', 'danger');
      }
    };
  }

  window.eliminarCita = eliminarCita;
})();
